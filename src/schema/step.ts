import { z } from 'zod';
import { ElementTarget, ValueRef } from './locator.js';
import { Checkpoint } from './checkpoint.js';

/**
 * Risk class, declared per step and enforced by the policy gate on both the discovery
 * and replay paths.
 *
 * The classification is a property of the *step*, not of the action verb: a click on
 * "Search" and a click on "Confirm transfer" are the same verb and very different
 * risks. The recorder proposes a class from the control's semantics; a human reviewing
 * the artifact can raise it, and policy decides what each class is allowed to do.
 */
export const RiskClass = z.enum([
  /** Read-only or trivially undone: navigation, search, reading a value. */
  'safe',
  /** Writes state but is reversible or low-consequence: filling a form, opening a draft. */
  'elevated',
  /** Not undoable from inside the app: submitting a transfer, closing an account. */
  'irreversible',
]);
export type RiskClass = z.infer<typeof RiskClass>;

export const ExtractSpec = z.object({
  /** Must match a declared output name on the capability. */
  name: z.string(),
  /** Which part of the resolved element to read. */
  from: z.enum(['text', 'value', 'attribute']).default('text'),
  attribute: z.string().optional(),
  /** Applied before typing. Keeps the artifact honest about parsing rather than hiding it in code. */
  transform: z.enum(['none', 'trim', 'currency_to_number', 'digits_only']).default('trim'),
});
export type ExtractSpec = z.infer<typeof ExtractSpec>;

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().describe('May contain {input.name} placeholders.') }),
  z.object({ kind: z.literal('click') }),
  z.object({ kind: z.literal('type'), value: ValueRef, clearFirst: z.boolean().default(true) }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  z.object({ kind: z.literal('select'), value: ValueRef }),
  z.object({ kind: z.literal('extract'), extracts: z.array(ExtractSpec).min(1) }),
  /** Assert-only step. Used to pin an intermediate screen without touching it. */
  z.object({ kind: z.literal('assert') }),
]);
export type Action = z.infer<typeof Action>;
export type ActionKind = Action['kind'];

export const Step = z.object({
  id: z.string(),
  /** Why this step exists, in the recorder's words. Shown to a human on escalation. */
  intent: z.string(),
  action: Action,
  /** Required for every action except `navigate`. */
  target: ElementTarget.optional(),
  risk: RiskClass.default('safe'),
  /**
   * Must hold before acting. This is what makes replay resumable after a human takes
   * over the session: on resume we re-evaluate the precondition instead of assuming
   * the screen is where we left it.
   */
  precondition: Checkpoint.optional(),
  /** Must hold after acting before the next step runs. The per-step success proof. */
  postcondition: Checkpoint.optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  /** Retries of this step alone, for transient surface errors. Not for business failures. */
  maxAttempts: z.number().int().positive().default(2),
});
export type Step = z.infer<typeof Step>;
