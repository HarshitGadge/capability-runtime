import { z } from 'zod';

/**
 * The surface-independent view of a screen.
 *
 * This is the seam between "how we perceive a surface" and "the recorded flow".
 * Everything above this type — the agent loop, the artifact, the replay engine, the
 * policy gate — is written against `UiElement` and never against a DOM, a CSS selector
 * or a browser. A Windows UIA or macOS AX provider produces the same shape from
 * AutomationElement / AXUIElement properties; nothing downstream changes.
 */
export const UiElement = z.object({
  /** Stable only within one observation. Never persisted into an artifact. */
  ref: z.string(),
  role: z.string(),
  /** Accessible name, computed the way the platform computes it. May be empty on legacy surfaces. */
  name: z.string(),
  value: z.string().optional(),
  /** Label inferred from layout when no accessible name exists. The legacy escape hatch. */
  proximityLabel: z.string().optional(),
  placeholder: z.string().optional(),
  /** Visible text of the element itself. */
  text: z.string().optional(),
  disabled: z.boolean().default(false),
  focusable: z.boolean().default(false),
  checked: z.boolean().optional(),
  bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  frame: z.array(z.string()).default([]),
  /** Text of the containing row, when inside a table. Drives `row_containing` scoping. */
  rowText: z.string().optional(),
  /** Nearest landmark/region name, for `region` scoping and for operator context. */
  region: z.string().optional(),
});
export type UiElement = z.infer<typeof UiElement>;

export const Observation = z.object({
  observedAt: z.string(),
  url: z.string(),
  title: z.string(),
  elements: z.array(UiElement),
  /** Full visible text per frame, for text assertions and outcome detection. */
  textByFrame: z.record(z.string(), z.string()),
  /**
   * URL per frame. On a frameset portal the top-level URL never changes as the operator
   * moves between screens — every navigation happens inside a child frame — so a
   * checkpoint that only looks at the address bar can never tell two screens apart.
   */
  urlByFrame: z.record(z.string(), z.string()).default({}),
  /** Which perception provider produced this. Recorded so evidence is self-describing. */
  provider: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
});
export type Observation = z.infer<typeof Observation>;
