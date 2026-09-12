import crypto from 'node:crypto';
import type { CapabilityArtifact, TenantOverlay } from '../schema/artifact.js';
import type { Step } from '../schema/step.js';
import type { Observation, UiElement } from '../schema/observation.js';
import type { ReplayResult, StepTrace, FailureKind } from '../schema/result.js';
import { PolicyGate, PolicyViolation, ConfirmationRequired } from '../policy/gate.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { evaluateCheckpoint, waitForCheckpoint, failedClauses } from './checkpoint.js';
import { resolveValue } from '../surface/locatorResolver.js';
import { applyOverlay, validateInputs } from './prepare.js';
import { stabilize } from './preflight.js';
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

/** Internal control-flow signals. Deliberately not exceptions the caller has to catch. */
/** What the engine does after a human handoff resolves. */
type EscalationDecision =
  | { action: 'retry' }
  | { action: 'skip' }
  | { action: 'terminate'; result: ReplayResult };

type StepOutcome =
  | { kind: 'ok'; trace: StepTrace }
  | { kind: 'business'; code: string; message: string; trace: StepTrace }
  | { kind: 'fail'; failure: FailureKind; expected: string; observed: string; remediation?: string; trace: StepTrace }
  | { kind: 'escalate'; reason: string; trace: StepTrace }
  | { kind: 'restart'; code: string; trace: StepTrace };

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
 *   2. Did a declared recovery condition appear? → remediate within budget, retry.
 *   3. Did the step's own postcondition hold? → continue.
 *   4. Otherwise → hard failure, or escalation if a human can unblock it.
 *
 * Business outcomes are checked *first and after every step*, before any retry logic
 * runs. Checking them last is the common bug: the engine spends its retry budget
 * hammering a screen that is already telling it, clearly, that there is no such member.
 */
export class ReplayEngine {
  private readonly bindings: Record<string, unknown>;
  private readonly outputs: Record<string, unknown> = {};
  private readonly trace: StepTrace[] = [];
  private readonly steps: Step[];
  private readonly artifact: CapabilityArtifact;
  private readonly startedAt = new Date();
  /** Latches once a non-undoable step has run; gates restart-style recoveries. */
  private irreversibleDone = false;
  readonly runId: string;

  constructor(private readonly opts: ReplayOptions) {
    this.runId = opts.recorder.runId;
    this.artifact = applyOverlay(opts.artifact, opts.overlay);
    this.steps = this.artifact.steps;
    this.bindings = { ...(opts.seedBindings ?? {}), baseUrl: opts.baseUrl };
    for (const [k, v] of Object.entries(opts.inputs)) this.bindings[`input.${k}`] = v;
  }

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
    };
  }

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
      try {
        gate.withContext({ risk: 'safe', stepId: '(entry)', intent: 'Open the application entry point' });
        await gate.navigate(this.interpolate(this.artifact.target.entryPoint));
      } catch (err) {
        return this.failNow('surface_error', `entry point ${this.artifact.target.entryPoint} to load`,
          err instanceof Error ? err.message : String(err), undefined,
          'Check that the target application is running and that baseUrl points at the right tenant.');
      }

      try {
        const applied = await stabilize(gate, this.artifact.recoveries, this.bindings, recorder);
        if (applied.length) recorder.event('note', { message: `preflight applied ${applied.join(', ')}` });
      } catch (err) {
        return this.failNow('surface_error', 'the surface to reach a startable state',
          err instanceof Error ? err.message : String(err), undefined,
          'Preflight could not establish a session. Check PORTAL_USER / PORTAL_PASS and that the app profile\'s sign-on locators still match.');
      }
    }

    for (let i = startIndex; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const outcome = await this.runStep(step);
      this.trace.push(outcome.trace);

      if (outcome.kind === 'business') {
        recorder.event('business_outcome', { code: outcome.code, atStep: step.id });
        const rule = this.artifact.businessOutcomes.find(b => b.code === outcome.code);
        const partial = Object.fromEntries(Object.entries(this.outputs).filter(([k]) => rule?.partialOutputs.includes(k)));
        recorder.event('run_finished', { status: 'business_outcome', code: outcome.code });
        return { status: 'business_outcome', ...this.base(), code: outcome.code, message: outcome.message, atStepId: step.id, outputs: partial };
      }

      if (outcome.kind === 'escalate') {
        const decision = await this.escalate(step, outcome.reason);
        // `retry`: a human unblocked the session and handed it back — re-run this step,
        // whose precondition now re-verifies that the screen is where they left it.
        // `skip`: the operator says they performed this step by hand; do not do it twice.
        if (decision.action === 'terminate') return decision.result;
        if (decision.action === 'retry') i -= 1;
        continue;
      }

      if (outcome.kind === 'restart') {
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
        gate.withContext({ risk: 'safe', stepId: '(restart)', intent: 'Reopen the entry point after recovery' });
        await gate.navigate(this.interpolate(this.artifact.target.entryPoint));
        await stabilize(gate, this.artifact.recoveries, this.bindings, recorder);
        i = startIndex - 1;
        continue;
      }

      if (outcome.kind === 'fail') {
        return this.failNow(outcome.failure, outcome.expected, outcome.observed, step.id, outcome.remediation);
      }
      if (step.risk === 'irreversible') this.irreversibleDone = true;
    }

    return this.finish();
  }

  // ---------------------------------------------------------------- step execution

  private async runStep(step: Step): Promise<StepOutcome> {
    const { gate, recorder } = this.opts;
    const started = Date.now();
    const traceBase = { stepId: step.id, intent: step.intent, recoveriesApplied: [] as string[] };
    recorder.event('step_started', { stepId: step.id, intent: step.intent, action: step.action.kind, risk: step.risk });
    gate.withContext({ risk: step.risk, stepId: step.id, intent: step.intent });

    for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
      const mk = (extra: Partial<StepTrace> = {}): StepTrace => ({
        ...traceBase, status: 'ok', attempts: attempt, durationMs: Date.now() - started, ...extra,
      });

      // --- precondition -------------------------------------------------------
      if (step.precondition) {
        const { result, observation } = await waitForCheckpoint(step.precondition, () => gate.observe(), this.bindings);
        if (!result.passed) {
          const classified = await this.classify(observation);
          if (classified) return { ...classified, trace: mk({ status: classified.kind === 'business' ? 'skipped' : 'failed' }) };
          const applied = await this.tryRecover(observation, step);
          if (applied) {
            traceBase.recoveriesApplied.push(applied.code);
            if (applied.then === 'restart_flow') return { kind: 'restart', code: applied.code, trace: mk({ status: 'recovered' }) };
            continue;
          }
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
      let obsBefore: Observation;
      let resolvedInfo: Partial<StepTrace> = {};
      try {
        obsBefore = await gate.observe();
        const actResult = await this.performAction(step, obsBefore);
        if (actResult.kind !== 'ok') return { ...actResult, trace: mk({ status: 'failed', ...actResult.traceExtra }) };
        resolvedInfo = actResult.traceExtra ?? {};
      } catch (err) {
        if (err instanceof ConfirmationRequired) {
          recorder.event('confirmation_required', { stepId: step.id, risk: step.risk, message: err.message });
          return { kind: 'escalate', reason: err.message, trace: mk({ status: 'skipped' }) };
        }
        if (err instanceof PolicyViolation) {
          recorder.event('policy_denied', { stepId: step.id, code: err.code, message: err.message });
          return { kind: 'fail', failure: 'policy_denied', expected: 'action permitted by the capability allowlist', observed: err.message, remediation: 'Widen the artifact allowlist only if the action is genuinely intended.', trace: mk({ status: 'failed' }) };
        }
        const message = err instanceof Error ? err.message : String(err);
        const obs = await gate.observe().catch(() => null);
        const classified = obs ? await this.classify(obs) : null;
        if (classified) return { ...classified, trace: mk({ status: 'failed' }) };
        if (obs) {
          const applied = await this.tryRecover(obs, step);
          if (applied) {
            traceBase.recoveriesApplied.push(applied.code);
            if (applied.then === 'restart_flow') return { kind: 'restart', code: applied.code, trace: mk({ status: 'recovered' }) };
            continue;
          }
        }
        if (attempt < step.maxAttempts) { recorder.event('step_retry', { stepId: step.id, attempt, message }); continue; }
        return { kind: 'fail', failure: 'surface_error', expected: `${step.action.kind} on ${step.target?.semanticId ?? 'surface'}`, observed: message, trace: mk({ status: 'failed' }) };
      }

      // --- postcondition ------------------------------------------------------
      if (step.postcondition) {
        const { result, observation } = await waitForCheckpoint(step.postcondition, () => gate.observe(), this.bindings);

        // Business outcomes are checked before retries, always. The app answering
        // "no such member" is a finished conversation, not a flaky one.
        const classified = await this.classify(observation);
        if (classified) return { ...classified, trace: mk({ status: classified.kind === 'business' ? 'ok' : 'failed', ...resolvedInfo }) };

        if (!result.passed) {
          const applied = await this.tryRecover(observation, step);
          if (applied) {
            traceBase.recoveriesApplied.push(applied.code);
            if (applied.then === 'restart_flow') return { kind: 'restart', code: applied.code, trace: mk({ status: 'recovered', ...resolvedInfo }) };

            // Re-verify before redoing anything. Dismissing an interstitial usually
            // reveals the screen the step was trying to reach, in which case the action
            // already succeeded and repeating it would be wrong — at best wasted work,
            // at worst a duplicate submission. Only when the screen is still not what
            // the step promised do we retry the action itself.
            const recheck = await waitForCheckpoint(step.postcondition, () => gate.observe(), this.bindings);
            if (recheck.result.passed) {
              recorder.event('checkpoint_passed', { stepId: step.id, phase: 'postcondition', afterRecovery: applied.code });
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
        recorder.event('checkpoint_passed', { stepId: step.id, phase: 'postcondition' });
      }

      recorder.event('step_succeeded', { stepId: step.id, ...resolvedInfo });
      return { kind: 'ok', trace: mk({ status: traceBase.recoveriesApplied.length ? 'recovered' : 'ok', ...resolvedInfo }) };
    }

    return { kind: 'fail', failure: 'timeout', expected: `step ${step.id} to complete within ${step.maxAttempts} attempts`, observed: 'attempts exhausted', trace: { ...traceBase, status: 'failed', attempts: step.maxAttempts, durationMs: Date.now() - started } };
  }

  private async performAction(step: Step, obs: Observation): Promise<
    ({ kind: 'ok' } | { kind: 'fail'; failure: FailureKind; expected: string; observed: string; remediation?: string }) & { traceExtra?: Partial<StepTrace> }
  > {
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
    if (resolved.candidates.length > 1 && step.target.ambiguity === 'require_unique') {
      return {
        kind: 'fail', failure: 'locator_ambiguous', traceExtra,
        expected: `exactly one match for ${step.target.semanticId}`,
        observed: `${resolved.candidates.length} matched via ${resolved.strategyUsed}: ${resolved.candidates.slice(0, 4).map(c => `${c.role}"${c.name || c.text}"`).join(', ')}`,
        remediation: 'Add a scope (row_containing / region) to the target so it selects within the right context.',
      };
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

  private readonly recoveryUse = new Map<string, number>();

  /**
   * Apply a declared recovery if one matches. Each rule has its own attempt budget, so
   * an interstitial that reappears forever exhausts its own budget and fails loudly
   * rather than looping — the failure mode that turns a broken run into a wedged one.
   */
  private async tryRecover(obs: Observation, step: Step): Promise<{ code: string; then: string } | null> {
    const { gate, recorder } = this.opts;
    for (const rule of this.artifact.recoveries) {
      if (!evaluateCheckpoint(rule.detect, obs, this.bindings).passed) continue;
      const used = this.recoveryUse.get(rule.code) ?? 0;
      if (used >= rule.maxAttempts) {
        recorder.event('note', { message: `recovery ${rule.code} exhausted after ${used} attempts` });
        continue;
      }
      this.recoveryUse.set(rule.code, used + 1);
      recorder.event('recovery_triggered', { code: rule.code, atStep: step.id, attempt: used + 1 });

      for (const action of rule.actions) {
        gate.withContext({ risk: action.risk, stepId: `${step.id}/recovery:${rule.code}`, intent: action.intent });
        const current = await gate.observe();
        const r = await this.performAction(action, current);
        if (r.kind !== 'ok') {
          recorder.event('note', { message: `recovery ${rule.code} failed: ${r.observed}` });
          return null;
        }
        if (action.postcondition) {
          await waitForCheckpoint(action.postcondition, () => gate.observe(), this.bindings);
        }
      }
      gate.withContext({ risk: step.risk, stepId: step.id, intent: step.intent });
      recorder.event('recovery_applied', { code: rule.code, then: rule.then });
      return { code: rule.code, then: rule.then };
    }
    return null;
  }

  // ------------------------------------------------------------------- escalation

  private async escalate(step: Step, reason: string): Promise<EscalationDecision> {
    const { escalator, recorder, gate } = this.opts;
    if (!escalator) {
      return { action: 'terminate', result: await this.failNow('policy_denied', 'a human to authorize this step', `${reason} (no escalation channel configured)`, step.id,
        'Run with an operator console attached, or lower the step risk after review.') };
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
      if (business) {
        recorder.event('run_finished', { status: 'business_outcome', code: business.code });
        return { status: 'business_outcome', ...this.base(), code: business.code, message: business.message, atStepId: this.steps.at(-1)!.id, outputs: {} };
      }
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
