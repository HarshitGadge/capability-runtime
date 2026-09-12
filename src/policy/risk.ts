import type { RiskClass, Action } from '../schema/step.js';
import type { UiElement } from '../schema/observation.js';

/**
 * Irreversibility is a property of what the control does, and the only signal available
 * at discovery time is what it says. These patterns are conservative by design: a false
 * positive costs one human confirmation, a false negative moves someone's money.
 */
const IRREVERSIBLE = /\b(transfer|wire|remit|disburse|delete|remove|close\s+account|open\s+account|authori[sz]e|submit\s+payment|pay\s+now|send\s+money|void|cancel\s+account)\b/i;
const ELEVATED = /\b(submit|save|create|open|confirm|apply|update|add)\b/i;

/**
 * Classify a step from the control it acts on.
 *
 * The recorder proposes; it does not decide. The classification is written into the
 * artifact where a human reviewing the capability can raise it before the capability is
 * ever invoked unattended, and policy — not this function — decides what each class is
 * permitted to do. Text heuristics are a weak signal and this is the right place for
 * them precisely because the output is reviewable rather than load-bearing at runtime.
 */
export function classifyRisk(action: Action, el?: UiElement): RiskClass {
  if (action.kind === 'extract' || action.kind === 'assert') return 'safe';
  if (action.kind === 'navigate') return 'safe';

  const label = [el?.name, el?.text, el?.value, el?.proximityLabel].filter(Boolean).join(' ');
  if (IRREVERSIBLE.test(label)) return 'irreversible';

  if (action.kind === 'click') {
    if (el?.role === 'link') return 'safe';
    return ELEVATED.test(label) ? 'elevated' : 'safe';
  }
  return 'elevated';
}

const ORDER: Record<RiskClass, number> = { safe: 0, elevated: 1, irreversible: 2 };
export const riskExceeds = (risk: RiskClass, ceiling: RiskClass): boolean => ORDER[risk] > ORDER[ceiling];
