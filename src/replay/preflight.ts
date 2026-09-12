import type { PolicyGate } from '../policy/gate.js';
import type { RecoveryRule } from '../schema/artifact.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import { evaluateCheckpoint } from './checkpoint.js';
import { resolveTarget, resolveValue } from '../surface/locatorResolver.js';

/**
 * Bring the surface to a state the capability can start from.
 *
 * A capability's steps describe the business flow and nothing else. Whether an
 * authenticated session already exists, whether a banner is covering the working area —
 * those are properties of the *session*, shared by every capability on the product, and
 * recording them into each one would be both duplication and a correctness bug: a
 * capability whose first step is "sign on" cannot run when the operator is already
 * signed on.
 *
 * So before the first step, the same app-level recovery rules that handle mid-flow
 * interruptions are applied until the screen stops changing. The preflight and the
 * mid-run handler are deliberately the same code reading the same rules: an interstitial
 * is an interstitial whether it appears before step one or after step four.
 */
export async function stabilize(
  gate: PolicyGate,
  recoveries: RecoveryRule[],
  bindings: Record<string, unknown>,
  recorder: EvidenceRecorder,
  maxRounds = 3,
): Promise<string[]> {
  const applied: string[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const obs = await gate.observe();
    const rule = recoveries.find(r => evaluateCheckpoint(r.detect, obs, bindings).passed);
    if (!rule) return applied;

    recorder.event('recovery_triggered', { code: rule.code, phase: 'preflight', round });
    for (const step of rule.actions) {
      gate.withContext({ risk: step.risk, stepId: `preflight:${rule.code}/${step.id}`, intent: step.intent });
      const current = await gate.observe();
      if (!step.target) continue;

      const resolved = resolveTarget(step.target, current, bindings);
      const el = resolved.candidates[0];
      if (!el) throw new Error(`preflight ${rule.code}: could not resolve ${step.target.semanticId} (tried ${resolved.attempts.map(a => a.strategy).join(' → ')})`);

      switch (step.action.kind) {
        case 'click': await gate.click(el); break;
        case 'type': await gate.type(el, resolveValue(step.action.value, bindings), step.action.clearFirst); break;
        case 'select': await gate.select(el, resolveValue(step.action.value, bindings)); break;
        case 'press': await gate.press(step.action.key); break;
        default: break;
      }
    }
    recorder.event('recovery_applied', { code: rule.code, phase: 'preflight' });
    applied.push(rule.code);
  }

  return applied;
}
