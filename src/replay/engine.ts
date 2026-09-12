import type { CapabilityArtifact, TenantOverlay } from '../schema/artifact.js';
import type { Step } from '../schema/step.js';
import type { Observation } from '../schema/observation.js';
import type { ReplayResult, StepTrace, FailureKind, SurfaceDrift } from '../schema/result.js';
import { PolicyGate, PolicyViolation, ConfirmationRequired } from '../policy/gate.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { evaluateCheckpoint, waitForCheckpoint, failedClauses } from './checkpoint.js';
import { resolveValue } from '../surface/locatorResolver.js';
import { applyOverlay, validateInputs } from './prepare.js';
import { stabilize } from './preflight.js';
import { screenShape, fingerprintOf } from '../agent/compiler.js';
import type { Escalator } from '../escalation/escalator.js';

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  overlay?: TenantOverlay;
  baseUrl: string;
  tenantId: string;
  inputs: Record<string, unknown>;
  gate: PolicyGate;
  recorder: EvidenceRecorder;
  escalator?: Escalator;
  /** Start at this step instead of the first. Set when resuming after a human handoff. */
  startAtStepId?: string;
  /** Carried across a resume so extracted values survive the handoff. */
  seedBindings?: Record<string, unknown>;
}

// ------------------------------------------------------------ internal signals
// Control flow inside the engine is expressed as values, not exceptions, so every path
// that ends a step or a run is visible in one place and has to name its outcome.

/** What happens to the blocked step once a human handoff resolves. */
type EscalationDecision =
  | { action: 'retry' }
  | { action: 'skip' }
  | { action: 'terminate'; result: ReplayResult };

/** If escalation is impossible (no operator channel), how the run should fail instead. */
interface EscalationFallback { kind: FailureKind; expected: string; remediation: string }

type Failure = { failure: FailureKind; expected: string; observed: string; remediation?: string };

type StepOutcome =
  | { kind: 'ok'; trace: StepTrace }
  | { kind: 'business'; code: string; message: string; trace: StepTrace }
  | ({ kind: 'fail'; trace: StepTrace } & Failure)
  | { kind: 'escalate'; reason: string; fallback?: EscalationFallback; trace: StepTrace }
  | { kind: 'restart'; code: string; trace: StepTrace };

type ActionResult = ({ kind: 'ok' } | ({ kind: 'fail' } & Failure) | { kind: 'escalate'; reason: string; fallback: EscalationFallback }) & { traceExtra?: Partial<StepTrace> };

/** What a recovery attempt produced. `exhausted` means a rule matched but had no budget left. */
type RecoveryResult =
  | { applied: string; then: string }
  | { exhausted: string; attempts: number; escalate: boolean }
  | null;

class StepTimeout extends Error {
  constructor(readonly stepId: string, readonly ms: number) { super(`step ${stepId} exceeded its ${ms} ms budget`); this.name = 'StepTimeout'; }
}

/**
 * Deterministic replay.
 *
 * No model is consulted here, and the module does not import one. Every decision comes
 * from the artifact: which control to find, what must be true before and after, which
 * screens are legitimate business answers, and which interruptions may be handled
 * without asking anyone.
 *
 * The engine's job is really the *classification* problem. Executing a step list is
 * easy; deciding what a given screen means when it is not the screen you expected is
 * the whole difficulty, and the order below is the answer:
 *
 *   1. Did a declared business outcome appear? → terminate, report it as a result.
 *   2. Did a declared recovery condition appear? → remediate within that rule's budget,
 *      then re-verify. A rule that is out of budget escalates if it says so, otherwise
 *      it is ignored and the step fails on its own terms.
 *   3. Did the step's own postcondition hold? → continue.
 *   4. Otherwise → hard failure, or escalation if a human can unblock it.
 *
 * Business outcomes are checked *first and after every step*, before any retry logic
 * runs. Checking them last is the common bug: the engine spends its retry budget
 * hammering a screen that is already telling it, clearly, that there is no such member.
 *
 * Three things route to a human rather than failing: a step above the unattended risk
 * ceiling, a target whose ambiguity policy is `escalate` resolving to several controls,
 * and a recovery rule exhausting its budget with `escalateOnExhaustion`. Everything else
 * — a control that cannot be found, a screen that never appeared — is a hard failure,
 * because a broken artifact is an engineering problem and paging an operator for it is
 * how an escalation queue stops being read.
 */
export class ReplayEngine {
  private readonly bindings: Record<string, unknown>;
  private readonly outputs: Record<string, unknown> = {};
  private readonly trace: StepTrace[] = [];
  private readonly steps: Step[];
  private readonly artifact: CapabilityArtifact;
  private readonly basePath: string;
  private readonly startedAt = new Date();
  /** Latches once a non-undoable step has run; gates restart-style recoveries. */
  private irreversibleDone = false;
  /** Per-rule attempt counters. */
  private readonly recoveryUse = new Map<string, number>();
  /** Shape of the screen each step produced, keyed by step id so a restarted step overwrites itself. */
  private readonly observedShapes = new Map<string, string>();
  private driftNoted = false;
  readonly runId: string;

  constructor(private readonly opts: ReplayOptions) {
    this.runId = opts.recorder.runId;
    this.artifact = applyOverlay(opts.artifact, opts.overlay);
    this.steps = this.artifact.steps;
    this.basePath = new URL(opts.baseUrl).pathname.replace(/\/$/, '');
    this.bindings = { ...(opts.seedBindings ?? {}), baseUrl: opts.baseUrl };
    for (const [k, v] of Object.entries(opts.inputs)) this.bindings[`input.${k}`] = v;
  }

  // ------------------------------------------------------------------- run loop

  async run(): Promise<ReplayResult> {
    const { recorder, gate } = this.opts;
    recorder.event('run_started', {
      capability: this.artifact.capability.id,
      version: this.artifact.capability.version,
      tenant: this.opts.tenantId,
      provider: gate.providerId,
      inputs: this.opts.inputs,
      resumingAt: this.opts.startAtStepId,
    });

    // Input validation happens before the browser is touched. A malformed member ID
    // should be an invalid_input failure from the contract, not a validation error
    // discovered three screens deep in someone else's UI.
    const invalid = validateInputs(this.artifact, this.opts.inputs);
    if (invalid) {
      return this.failNow('invalid_input', invalid.expected, invalid.observed, undefined, 'Fix the caller, not the capability.');
    }

    const startIndex = this.opts.startAtStepId ? Math.max(0, this.steps.findIndex(s => s.id === this.opts.startAtStepId)) : 0;

    // Open the capability's declared entry point, with {baseUrl} bound to this tenant.
    // Skipped when resuming: a run coming back from a human handoff must continue in
    // the session as they left it, and reloading would discard exactly the state the
    // handoff existed to preserve.
    if (!this.opts.startAtStepId) {
      const opened = await this.openEntryPoint();
      if (opened) return opened;
    }

    for (let i = startIndex; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const outcome = await this.runStep(step);
      this.trace.push(outcome.trace);

      switch (outcome.kind) {
        case 'ok':
          if (step.risk === 'irreversible') this.irreversibleDone = true;
          break;

        case 'business':
          return this.finishWithBusinessOutcome(outcome.code, outcome.message, step.id);

        case 'escalate': {
          const decision = await this.escalate(step, outcome.reason, outcome.fallback);
          // `retry`: a human unblocked the session and handed it back — re-run this step,
          // whose precondition now re-verifies that the screen is where they left it.
          // `skip`: the operator says they performed this step by hand; do not do it twice.
          if (decision.action === 'terminate') return decision.result;
          if (decision.action === 'retry') i -= 1;
          break;
        }

        case 'restart': {
          // A recovery rule asked to restart the flow (session re-established, say). This
          // is safe only while nothing irreversible has run: replaying a transfer because
          // the session dropped afterwards would be far worse than failing here.
          if (this.irreversibleDone) {
            return this.failNow('recovery_exhausted',
              'a restart-safe point in the flow',
              `recovery ${outcome.code} asked to restart the flow, but an irreversible step has already executed`,
              step.id, 'Resolve the interruption manually; this flow cannot be safely replayed from the start.');
          }
          // Restarting means starting over, which includes re-opening the entry point and
          // re-running preflight. Re-authenticating inside a content frame otherwise
          // leaves the app nested inside itself, and every subsequent locator resolves
          // against a screen that no longer means what it did when the flow was recorded.
          recorder.event('note', { message: `restarting flow after recovery ${outcome.code}` });
          const reopened = await this.openEntryPoint('(restart)');
          if (reopened) return reopened;
          i = startIndex - 1;
          break;
        }

        case 'fail':
          return this.failNow(outcome.failure, outcome.expected, outcome.observed, step.id, outcome.remediation);
      }
    }

    return this.finish();
  }

  /** Navigate to the entry point and let preflight settle the surface. Returns a result only on failure. */
  private async openEntryPoint(stepId = '(entry)'): Promise<ReplayResult | null> {
    const { gate, recorder } = this.opts;
    try {
      gate.withContext({ risk: 'safe', stepId, intent: 'Open the application entry point' });
      await gate.navigate(this.interpolate(this.artifact.target.entryPoint));
    } catch (err) {
      return this.failNow('surface_error', `entry point ${this.artifact.target.entryPoint} to load`,
        errorMessage(err), undefined,
        'Check that the target application is running and that baseUrl points at the right tenant.');
    }
    try {
      const applied = await stabilize(gate, this.artifact.recoveries, this.bindings, recorder);
      if (applied.length) recorder.event('note', { message: `preflight applied ${applied.join(', ')}` });
    } catch (err) {
      return this.failNow('surface_error', 'the surface to reach a startable state',
        errorMessage(err), undefined,
        'Preflight could not establish a session. Check PORTAL_USER / PORTAL_PASS and that the app profile\'s sign-on locators still match.');
    }
    return null;
  }

  // ---------------------------------------------------------------- step execution

  private async runStep(step: Step): Promise<StepOutcome> {
    const { gate, recorder } = this.opts;
    const started = Date.now();
    const recoveriesApplied: string[] = [];
    recorder.event('step_started', { stepId: step.id, intent: step.intent, action: step.action.kind, risk: step.risk });
    gate.withContext({ risk: step.risk, stepId: step.id, intent: step.intent });

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      const mk = (extra: Partial<StepTrace> = {}): StepTrace => ({
        stepId: step.id, intent: step.intent, recoveriesApplied,
        status: 'ok', attempts: attempt, durationMs: Date.now() - started, ...extra,
      });

      /**
       * Map a recovery result onto the step's control flow. `null` means "nothing to do
       * here, carry on with the normal failure path"; a StepOutcome ends the step; the
       * string 'retry' means the loop should go round again.
       */
      const afterRecovery = (r: RecoveryResult, extra: Partial<StepTrace> = {}): StepOutcome | 'retry' | null => {
        if (!r) return null;
        if ('exhausted' in r) {
          if (!r.escalate) return null;
          return {
            kind: 'escalate',
            reason: `recovery ${r.exhausted} exhausted after ${r.attempts} attempt(s) at step ${step.id}`,
            fallback: { kind: 'recovery_exhausted', expected: `recovery ${r.exhausted} to clear the interruption within ${r.attempts} attempt(s)`, remediation: 'The interruption keeps recurring. Resolve it manually or raise the rule\'s maxAttempts after review.' },
            trace: mk({ status: 'failed', ...extra }),
          };
        }
        recoveriesApplied.push(r.applied);
        if (r.then === 'restart_flow') return { kind: 'restart', code: r.applied, trace: mk({ status: 'recovered', ...extra }) };
        return 'retry';
      };

      // --- precondition -------------------------------------------------------
      if (step.precondition) {
        const { result, observation } = await waitForCheckpoint(step.precondition, () => gate.observe(), this.bindings);
        if (!result.passed) {
          const classified = await this.classify(observation);
          if (classified) return { ...classified, trace: mk({ status: 'skipped' }) };
          const routed = afterRecovery(await this.tryRecover(observation, step));
          if (routed === 'retry') continue;
          if (routed) return routed;
          recorder.event('checkpoint_failed', { stepId: step.id, phase: 'precondition', failed: failedClauses(result) });
          return {
            kind: 'fail', failure: 'precondition_unmet',
            expected: `${step.precondition.description} — ${failedClauses(result)}`,
            observed: `url=${observation.url}`,
            remediation: 'The screen before this step was not what the capability expects. Check the preceding step and any tenant overlay.',
            trace: mk({ status: 'failed' }),
          };
        }
      }

      // --- act ----------------------------------------------------------------
      let resolvedInfo: Partial<StepTrace> = {};
      try {
        const before = await gate.observe();
        const acted = await withTimeout(this.performAction(step, before), step.timeoutMs, () => new StepTimeout(step.id, step.timeoutMs));
        resolvedInfo = acted.traceExtra ?? {};
        if (acted.kind === 'fail') return { ...acted, trace: mk({ status: 'failed', ...resolvedInfo }) };
        if (acted.kind === 'escalate') return { kind: 'escalate', reason: acted.reason, fallback: acted.fallback, trace: mk({ status: 'skipped', ...resolvedInfo }) };
      } catch (err) {
        if (err instanceof ConfirmationRequired) {
          recorder.event('confirmation_required', { stepId: step.id, risk: step.risk, message: err.message });
          return { kind: 'escalate', reason: err.message, trace: mk({ status: 'skipped' }) };
        }
        if (err instanceof PolicyViolation) {
          recorder.event('policy_denied', { stepId: step.id, code: err.code, message: err.message });
          return { kind: 'fail', failure: 'policy_denied', expected: 'action permitted by the capability allowlist', observed: err.message, remediation: 'Widen the artifact allowlist only if the action is genuinely intended.', trace: mk({ status: 'failed' }) };
        }
        if (err instanceof StepTimeout) {
          // The underlying browser call cannot be cancelled and may still complete in the
          // background; the step budget bounds how long the *run* waits, not the surface.
          recorder.event('step_retry', { stepId: step.id, attempt, message: err.message });
          if (attempt < step.maxAttempts) continue;
          return { kind: 'fail', failure: 'timeout', expected: `step ${step.id} (${step.action.kind}) to complete within ${step.timeoutMs} ms`, observed: `still running after ${step.timeoutMs} ms on attempt ${attempt} of ${step.maxAttempts}`, remediation: 'The surface is slower than the artifact allows. Raise the step\'s timeoutMs if this is expected, or check the target application.', trace: mk({ status: 'failed' }) };
        }
        const message = errorMessage(err);
        const obs = await gate.observe().catch(() => null);
        const classified = obs ? await this.classify(obs) : null;
        if (classified) return { ...classified, trace: mk({ status: 'failed' }) };
        const routed = obs ? afterRecovery(await this.tryRecover(obs, step)) : null;
        if (routed === 'retry') continue;
        if (routed) return routed;
        if (attempt < step.maxAttempts) { recorder.event('step_retry', { stepId: step.id, attempt, message }); continue; }
        return { kind: 'fail', failure: 'surface_error', expected: `${step.action.kind} on ${step.target?.semanticId ?? 'surface'}`, observed: message, trace: mk({ status: 'failed' }) };
      }

      // --- postcondition ------------------------------------------------------
      if (step.postcondition) {
        const { result, observation } = await waitForCheckpoint(step.postcondition, () => gate.observe(), this.bindings);

        // Business outcomes are checked before retries, always. The app answering
        // "no such member" is a finished conversation, not a flaky one.
        const classified = await this.classify(observation);
        if (classified) return { ...classified, trace: mk({ status: 'ok', ...resolvedInfo }) };

        if (result.passed) {
          this.recordShape(step, observation);
          recorder.event('checkpoint_passed', { stepId: step.id, phase: 'postcondition' });
        } else {
          const recovery = await this.tryRecover(observation, step);
          const routed = afterRecovery(recovery, resolvedInfo);
          if (routed && routed !== 'retry') return routed;
          if (routed === 'retry') {
            // Re-verify before redoing anything. Dismissing an interstitial usually
            // reveals the screen the step was trying to reach, in which case the action
            // already succeeded and repeating it would be wrong — at best wasted work,
            // at worst a duplicate submission. Only when the screen is still not what
            // the step promised do we retry the action itself.
            const recheck = await waitForCheckpoint(step.postcondition, () => gate.observe(), this.bindings);
            if (recheck.result.passed) {
              this.recordShape(step, recheck.observation);
              recorder.event('checkpoint_passed', { stepId: step.id, phase: 'postcondition', afterRecovery: recoveriesApplied.at(-1) });
              return { kind: 'ok', trace: mk({ status: 'recovered', ...resolvedInfo }) };
            }
            continue;
          }
          recorder.event('checkpoint_failed', { stepId: step.id, phase: 'postcondition', failed: failedClauses(result) });
          if (attempt < step.maxAttempts) continue;
          await recorder.failureBundle(gate, observation, step.id);
          return {
            kind: 'fail', failure: 'postcondition_unmet',
            expected: `${step.postcondition.description} — ${failedClauses(result)}`,
            observed: `url=${observation.url}`,
            remediation: 'The action ran but the screen it should have produced did not appear.',
            trace: mk({ status: 'failed', ...resolvedInfo }),
          };
        }
      } else {
        this.recordShape(step, await gate.observe());
      }

      recorder.event('step_succeeded', { stepId: step.id, ...resolvedInfo });
      return { kind: 'ok', trace: mk({ status: recoveriesApplied.length ? 'recovered' : 'ok', ...resolvedInfo }) };
    }

    // Reached only when every attempt ended in a `continue` — a recovery that applied
    // but never produced the expected screen, say. Each retry was already logged.
    return {
      kind: 'fail', failure: 'attempts_exhausted',
      expected: `step ${step.id} to succeed within ${step.maxAttempts} attempt(s)`,
      observed: `all ${step.maxAttempts} attempt(s) ended without the step's postcondition holding`,
      remediation: 'See the step_retry and recovery events in the run log for what each attempt saw.',
      trace: { stepId: step.id, intent: step.intent, recoveriesApplied, status: 'failed', attempts: step.maxAttempts, durationMs: Date.now() - started },
    };
  }

  private async performAction(step: Step, obs: Observation): Promise<ActionResult> {
    const { gate, recorder } = this.opts;

    if (step.action.kind === 'navigate') {
      await gate.navigate(this.interpolate(step.action.url));
      return { kind: 'ok' };
    }

    if (!step.target) {
      return { kind: 'fail', failure: 'surface_error', expected: 'a target for a non-navigate step', observed: `step ${step.id} has no target` };
    }

    const resolved = await gate.resolve(step.target, obs, this.bindings);
    const traceExtra: Partial<StepTrace> = { locatorStrategyUsed: resolved.strategyUsed, locatorCandidates: resolved.candidates.length };
    recorder.event('locator_resolved', { stepId: step.id, semanticId: step.target.semanticId, used: resolved.strategyUsed, candidates: resolved.candidates.length, attempts: resolved.attempts });

    if (resolved.candidates.length === 0) {
      return {
        kind: 'fail', failure: 'locator_not_found', traceExtra,
        expected: `${step.target.semanticId} (${step.target.description})`,
        observed: `no element matched any of ${step.target.strategies.length} strategies: ${resolved.attempts.map(a => a.strategy).join(' → ')}`,
        remediation: 'If the tenant renamed this control, add a targetOverride to that tenant\'s overlay rather than re-recording the capability.',
      };
    }

    // More than one candidate is a judgement call the artifact makes per target.
    // `require_unique` (the default) refuses to guess; `first` is for targets whose
    // document order was proven meaningful at record time; `escalate` hands the choice
    // to a person, which is the right policy when the step is one you cannot undo.
    if (resolved.candidates.length > 1 && step.target.ambiguity !== 'first') {
      const listing = resolved.candidates.slice(0, 4).map(c => `${c.role}"${c.name || c.text || c.proximityLabel || ''}"`).join(', ');
      const observed = `${resolved.candidates.length} matched via ${resolved.strategyUsed}: ${listing}`;
      const remediation = 'Add a scope (row_containing / region) to the target so it selects within the right context.';
      if (step.target.ambiguity === 'escalate') {
        recorder.event('note', { message: `ambiguous target ${step.target.semanticId} routed to a human`, observed });
        return {
          kind: 'escalate', traceExtra,
          reason: `Target ${step.target.semanticId} is ambiguous (${observed}); this target is marked to escalate rather than guess`,
          fallback: { kind: 'locator_ambiguous', expected: `exactly one match for ${step.target.semanticId}`, remediation },
        };
      }
      return { kind: 'fail', failure: 'locator_ambiguous', traceExtra, expected: `exactly one match for ${step.target.semanticId}`, observed, remediation };
    }
    const el = resolved.candidates[0]!;

    switch (step.action.kind) {
      case 'click': await gate.click(el); break;
      case 'type': await gate.type(el, resolveValue(step.action.value, this.bindings), step.action.clearFirst); break;
      case 'select': await gate.select(el, resolveValue(step.action.value, this.bindings)); break;
      case 'press': await gate.press(step.action.key); break;
      case 'assert': break;
      case 'extract': {
        for (const spec of step.action.extracts) {
          const raw = spec.from === 'value' ? (el.value ?? '') : (el.text ?? el.name ?? '');
          this.outputs[spec.name] = transform(raw, spec.transform);
          this.bindings[`extracted.${spec.name}`] = this.outputs[spec.name];
          recorder.event('note', { message: `extracted ${spec.name}`, ...this.loggableOutput(spec.name) });
        }
        break;
      }
    }
    return { kind: 'ok', traceExtra };
  }

  // ------------------------------------------------------- classification helpers

  /** Is this screen a declared business outcome? Checked after every step. */
  private async classify(obs: Observation): Promise<{ kind: 'business'; code: string; message: string } | null> {
    for (const rule of this.artifact.businessOutcomes) {
      if (evaluateCheckpoint(rule.detect, obs, this.bindings).passed) {
        return { kind: 'business', code: rule.code, message: rule.description };
      }
    }
    return null;
  }

  /**
   * Apply a declared recovery if one matches. Each rule has its own attempt budget, so
   * an interstitial that reappears forever exhausts its own budget and fails loudly
   * rather than looping — the failure mode that turns a broken run into a wedged one.
   * An exhausted rule is reported as such so the caller can escalate if the rule asks.
   */
  private async tryRecover(obs: Observation, step: Step): Promise<RecoveryResult> {
    const { gate, recorder } = this.opts;
    let exhausted: RecoveryResult = null;
    for (const rule of this.artifact.recoveries) {
      if (!evaluateCheckpoint(rule.detect, obs, this.bindings).passed) continue;
      const used = this.recoveryUse.get(rule.code) ?? 0;
      if (used >= rule.maxAttempts) {
        // Remembered rather than returned: another rule may still apply to this screen,
        // and it gets its turn before an exhausted one decides the step's fate.
        recorder.event('note', { message: `recovery ${rule.code} exhausted after ${used} attempt(s)`, escalate: rule.escalateOnExhaustion });
        exhausted ??= { exhausted: rule.code, attempts: used, escalate: rule.escalateOnExhaustion };
        continue;
      }
      this.recoveryUse.set(rule.code, used + 1);
      recorder.event('recovery_triggered', { code: rule.code, atStep: step.id, attempt: used + 1 });

      for (const action of rule.actions) {
        gate.withContext({ risk: action.risk, stepId: `${step.id}/recovery:${rule.code}`, intent: action.intent });
        const current = await gate.observe();
        const r = await this.performAction(action, current);
        if (r.kind !== 'ok') {
          recorder.event('note', { message: `recovery ${rule.code} failed: ${r.kind === 'fail' ? r.observed : r.reason}` });
          gate.withContext({ risk: step.risk, stepId: step.id, intent: step.intent });
          return null;
        }
        if (action.postcondition) {
          await waitForCheckpoint(action.postcondition, () => gate.observe(), this.bindings);
        }
      }
      gate.withContext({ risk: step.risk, stepId: step.id, intent: step.intent });
      recorder.event('recovery_applied', { code: rule.code, then: rule.then });
      return { applied: rule.code, then: rule.then };
    }
    return exhausted;
  }

  // ------------------------------------------------------------------- escalation

  private async escalate(step: Step, reason: string, fallback?: EscalationFallback): Promise<EscalationDecision> {
    const { escalator, recorder, gate } = this.opts;
    if (!escalator) {
      const fb = fallback ?? { kind: 'policy_denied' as const, expected: 'a human to authorize this step', remediation: 'Run with an operator console attached, or lower the step risk after review.' };
      return { action: 'terminate', result: await this.failNow(fb.kind, fb.expected, `${reason} (no escalation channel configured)`, step.id, fb.remediation) };
    }
    const obs = await gate.observe().catch(() => null);
    const handoff = await escalator.request({
      capabilityId: this.artifact.capability.id,
      capabilityVersion: this.artifact.capability.version,
      runId: this.runId,
      tenantId: this.opts.tenantId,
      stepId: step.id,
      stepIntent: step.intent,
      reason,
      observation: obs,
      bindings: this.redactBindings(),
    });

    if (handoff.resolution === 'resumed') {
      recorder.event('control_returned', { interventionId: handoff.interventionId, humanActions: handoff.humanActions?.length ?? 0, note: handoff.note });
      if (handoff.humanActions?.length) recorder.event('human_action', { interventionId: handoff.interventionId, actions: handoff.humanActions });
      if (handoff.authorizeStep) {
        gate.authorizeOnce(step.id);
        recorder.event('note', { message: `operator authorized one execution of step ${step.id}`, interventionId: handoff.interventionId });
      }
      if (handoff.skipStep) {
        recorder.event('note', { message: `operator performed step ${step.id} manually; continuing after it` });
        this.trace.push({ stepId: step.id, intent: step.intent, status: 'skipped', attempts: 0, durationMs: 0, recoveriesApplied: [] });
        return { action: 'skip' };
      }
      return { action: 'retry' };
    }

    recorder.event('run_finished', { status: 'escalated', interventionId: handoff.interventionId });
    return {
      action: 'terminate',
      result: {
        status: 'escalated', ...this.base(),
        interventionId: handoff.interventionId,
        reason,
        atStepId: step.id,
        resumable: handoff.resumable,
        resumeToken: handoff.resumeToken,
      },
    };
  }

  // -------------------------------------------------------------- drift & outputs

  private recordShape(step: Step, obs: Observation): void {
    this.observedShapes.set(step.id, screenShape(obs, this.basePath));
  }

  /**
   * Compare what this run saw against what the recording saw. Judged only over complete
   * runs — a run that stopped at step two cannot say whether steps three and four
   * still look the same, and reporting "no drift" there would be a guess dressed as a
   * measurement. Drift never fails a run; the checkpoints already decided that. It says
   * the surface has changed shape since recording and the capability is due a review.
   */
  private surfaceDrift(): SurfaceDrift {
    const shapes = this.steps.map(s => this.observedShapes.get(s.id)).filter((s): s is string => s !== undefined);
    const complete = shapes.length === this.steps.length;
    const observed = complete ? fingerprintOf(shapes) : '';
    const recorded = this.artifact.provenance.surfaceFingerprint;
    const drifted = complete ? observed !== recorded : null;
    // Name the steps whose screens changed, not just the hash. "Step 4's screen went from
    // 6 controls to 7" is actionable; a differing digest is a shrug.
    const recordedShapes = this.artifact.provenance.stepShapes ?? {};
    const changedSteps = this.steps.flatMap(s => {
      const o = this.observedShapes.get(s.id), r = recordedShapes[s.id];
      return o !== undefined && r !== undefined && o !== r ? [{ stepId: s.id, recorded: r, observed: o }] : [];
    });
    if (drifted && !this.driftNoted) {
      this.driftNoted = true;
      this.opts.recorder.event('note', { message: 'surface fingerprint drifted from the recording; re-review this capability for this tenant', recorded, observed, changedSteps });
    }
    return { recorded, observed, comparedSteps: shapes.length, totalSteps: this.steps.length, drifted, changedSteps };
  }

  /**
   * Outputs as they may be written to disk.
   *
   * The pattern-based redactor is a backstop over free text and it does not catch
   * everything: a balance extracted and normalized to the number 18204.37 no longer
   * looks like currency to a regex. Declared sensitivity is the authoritative signal, so
   * regulated and secret outputs are masked by their *declaration* rather than by their
   * shape. They are still returned to the in-process caller in the clear — that is the
   * point of the capability — they are simply never persisted.
   */
  private loggableOutput(name: string): Record<string, unknown> {
    const spec = this.artifact.outputs.find(o => o.name === name);
    const value = this.outputs[name];
    if (!spec || spec.sensitivity === 'regulated' || spec.sensitivity === 'secret') {
      return { sensitivity: spec?.sensitivity ?? 'regulated', value: `«withheld:${spec?.type ?? 'unknown'}»` };
    }
    return { sensitivity: spec.sensitivity, value: String(value) };
  }

  private loggableOutputs(): Record<string, unknown> {
    return Object.fromEntries(Object.keys(this.outputs).map(n => [n, this.loggableOutput(n).value]));
  }

  private redactBindings(): Record<string, unknown> {
    return this.opts.gate.redactor.redactDeep(this.bindings, 'evidence');
  }

  // ---------------------------------------------------------------- terminal paths

  private base(): Omit<ReplayResult & { status: 'success' }, 'status' | 'outputs'> {
    return {
      capabilityId: this.artifact.capability.id,
      capabilityVersion: this.artifact.capability.version,
      runId: this.runId,
      tenantId: this.opts.tenantId,
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      evidenceDir: this.opts.recorder.relDir(),
      trace: this.trace,
      surfaceDrift: this.surfaceDrift(),
    };
  }

  private finishWithBusinessOutcome(code: string, message: string, atStepId: string): ReplayResult {
    const { recorder } = this.opts;
    recorder.event('business_outcome', { code, atStep: atStepId });
    const rule = this.artifact.businessOutcomes.find(b => b.code === code);
    const partial = Object.fromEntries(Object.entries(this.outputs).filter(([k]) => rule?.partialOutputs.includes(k)));
    recorder.event('run_finished', { status: 'business_outcome', code });
    return { status: 'business_outcome', ...this.base(), code, message, atStepId, outputs: partial };
  }

  private async failNow(kind: FailureKind, expected: string, observed: string, atStepId?: string, remediation?: string): Promise<ReplayResult> {
    const { recorder, gate } = this.opts;
    const obs = await gate.observe().catch(() => null);
    const bundle = await recorder.failureBundle(gate, obs, atStepId ?? kind);
    recorder.event('step_failed', { kind, atStepId, expected, observed, ...bundle });
    recorder.event('run_finished', { status: 'failure', kind });
    return { status: 'failure', ...this.base(), kind, atStepId, expected, observed, remediation, ...bundle };
  }

  private async finish(): Promise<ReplayResult> {
    const { gate, recorder } = this.opts;

    const { result, observation } = await waitForCheckpoint(this.artifact.success, () => gate.observe(), this.bindings);
    if (!result.passed) {
      const business = await this.classify(observation);
      if (business) return this.finishWithBusinessOutcome(business.code, business.message, this.steps.at(-1)!.id);
      return this.failNow('success_condition_unmet', `${this.artifact.success.description} — ${failedClauses(result)}`, `url=${observation.url}`, this.steps.at(-1)?.id,
        'Every step reported success but the capability-level success condition did not hold. Suspect a step whose postcondition is too weak.');
    }

    const missing = this.artifact.outputs.filter(o => o.required && this.outputs[o.name] == null).map(o => o.name);
    if (missing.length) {
      return this.failNow('missing_required_output', `outputs [${missing.join(', ')}] to be extracted`, 'they were not', this.steps.at(-1)?.id,
        'The flow reached the success screen but an extraction step did not produce its declared output.');
    }

    recorder.event('checkpoint_passed', { phase: 'success', description: this.artifact.success.description });
    recorder.event('run_finished', { status: 'success', outputs: this.loggableOutputs() });
    return { status: 'success', ...this.base(), outputs: this.outputs };
  }

  private interpolate(template: string): string {
    return template.replace(/\{([\w.]+)\}/g, (_, key) => String(this.bindings[key] ?? this.bindings[`input.${key}`] ?? ''));
  }
}

// ------------------------------------------------------------------------ helpers

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Bound a promise by wall-clock time. The timer is cleared either way so it never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

function transform(raw: string, mode: string): string | number {
  const t = raw.trim();
  switch (mode) {
    case 'none': return raw;
    case 'digits_only': return t.replace(/\D+/g, '');
    case 'currency_to_number': {
      const n = Number(t.replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : t;
    }
    default: return t;
  }
}
