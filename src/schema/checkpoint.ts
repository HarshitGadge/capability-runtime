import { z } from 'zod';
import { ElementTarget, ValueRef, TextMatch, Scope } from './locator.js';

/**
 * Assertions over an observation. Deliberately a small, declarative language rather
 * than embedded predicates: checkpoints must be serializable into the artifact,
 * reviewable by a human, and evaluable by the replay engine with no model and no
 * arbitrary code execution.
 *
 * Note what is absent: no screenshot diffing and no DOM-shape assertions. Both fail
 * on restyled tenants for reasons that have nothing to do with whether the flow
 * actually worked.
 */
export const Assertion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url_matches'), pattern: z.string().describe('RegExp source, matched against the active frame URL.') }),
  z.object({ kind: z.literal('element_present'), target: ElementTarget }),
  z.object({ kind: z.literal('element_absent'), target: ElementTarget }),
  z.object({
    kind: z.literal('text_present'),
    text: ValueRef,
    match: TextMatch.default('contains'),
    scope: Scope.optional(),
  }),
  z.object({ kind: z.literal('text_absent'), text: ValueRef, match: TextMatch.default('contains') }),
  /** Guards against acting on a half-rendered page without coupling to a spinner's markup. */
  z.object({ kind: z.literal('element_count'), target: ElementTarget, min: z.number().int().optional(), max: z.number().int().optional() }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const Checkpoint = z.object({
  description: z.string(),
  /** All must hold. Conjunction only — disjunction would make failures much harder to explain. */
  all: z.array(Assertion).min(1),
  timeoutMs: z.number().int().positive().default(10_000),
  /** Poll interval while waiting for the assertions to become true. */
  pollMs: z.number().int().positive().default(250),
});
export type Checkpoint = z.infer<typeof Checkpoint>;
