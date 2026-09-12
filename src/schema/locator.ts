import { z } from 'zod';

/**
 * A value that a step consumes. Kept as a tagged union rather than a raw string so
 * the artifact is self-describing: a reviewer can see at a glance which values are
 * caller-supplied, which are baked in, and which flow from an earlier extraction.
 */
export const ValueRef = z.union([
  z.object({ kind: z.literal('const'), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ kind: z.literal('input'), name: z.string() }),
  z.object({ kind: z.literal('extracted'), name: z.string() }),
  /** Resolved from the environment at replay time and never persisted (credentials). */
  z.object({ kind: z.literal('secret'), envVar: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

export const TextMatch = z.enum(['exact', 'contains', 'regex', 'normalized']);
export type TextMatch = z.infer<typeof TextMatch>;

/**
 * One way to find a control. A target carries several of these in priority order.
 *
 * The ordering is deliberate and is the core robustness argument of this system:
 * strategies near the top describe what a control *means* to a user and survive
 * restyling, DOM reordering and tenant skinning; strategies near the bottom describe
 * where it happened to be during recording and survive almost nothing. Replay walks
 * the list top-down and reports which rung it landed on, so degradation is visible
 * rather than silent.
 */
export const LocatorStrategy = z.discriminatedUnion('kind', [
  /** Accessible role + accessible name. Survives CSS, DOM order, and most skinning. */
  z.object({
    kind: z.literal('role_name'),
    role: z.string(),
    name: z.string(),
    match: TextMatch.default('normalized'),
  }),
  /**
   * Role + a label derived from layout proximity rather than a11y wiring. The legacy
   * case: a bare <input> in a table cell whose only label is the text in the cell to
   * its left. No accessible name exists, so nothing above this rung can find it.
   */
  z.object({
    kind: z.literal('proximity_label'),
    role: z.string(),
    label: z.string(),
    match: TextMatch.default('normalized'),
  }),
  z.object({ kind: z.literal('placeholder'), placeholder: z.string(), match: TextMatch.default('normalized') }),
  /** Visible text of the control itself — links, buttons rendered as anchors. */
  z.object({ kind: z.literal('text'), text: z.string(), role: z.string().optional(), match: TextMatch.default('normalized') }),
  /** Present for completeness; absent on every legacy surface we care about. */
  z.object({ kind: z.literal('test_id'), attribute: z.string(), value: z.string() }),
  /** Nth control of a role within the resolved scope. Ordering-dependent, hence low. */
  z.object({ kind: z.literal('ordinal'), role: z.string(), index: z.number().int().nonnegative() }),
  /**
   * Viewport coordinates captured at record time. Never used to *choose* an element —
   * only to disambiguate between otherwise-equal candidates, and recorded so a human
   * reviewing a failure can see where the control used to be.
   */
  z.object({
    kind: z.literal('coordinates'),
    x: z.number(),
    y: z.number(),
    viewport: z.object({ width: z.number(), height: z.number() }),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

/**
 * Narrows where strategies are evaluated. `row_containing` is the one that matters in
 * practice: "the View link in the row for member {memberId}" is stable across result
 * sets, where "the third View link" is not.
 */
export const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('row_containing'), text: ValueRef }),
  z.object({ kind: z.literal('region'), role: z.string(), name: z.string() }),
  z.object({ kind: z.literal('near_text'), text: z.string(), withinPx: z.number().default(240) }),
]);
export type Scope = z.infer<typeof Scope>;

/** How to behave when the strategy cascade yields more than one candidate. */
export const AmbiguityPolicy = z.enum([
  /** Require exactly one match; more than one is a hard failure. The default. */
  'require_unique',
  /** Accept the first match in document order. Only set when recording proved order is meaningful. */
  'first',
  /** Ambiguity routes to a human rather than guessing. Used for irreversible steps. */
  'escalate',
]);

/**
 * A frame path from the top document, by frame `name` (or index when unnamed).
 * Empty array means the top document. Legacy portals put everything one or two
 * frames deep, so this is not an edge case.
 */
export const FramePath = z.array(z.string());

export const ElementTarget = z.object({
  /**
   * Stable logical name for this control, e.g. "member_search.id_field". This is the
   * join key for tenant overlays: an overlay replaces the strategies for a semanticId
   * without touching the step sequence. It is what makes one artifact serve many
   * tenants instead of one artifact per tenant.
   */
  semanticId: z.string(),
  description: z.string().describe('Human-readable, for review and for operator context on escalation.'),
  strategies: z.array(LocatorStrategy).min(1),
  scope: Scope.optional(),
  frame: FramePath.default([]),
  ambiguity: AmbiguityPolicy.default('require_unique'),
});
export type ElementTarget = z.infer<typeof ElementTarget>;
