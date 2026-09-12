import type { Observation, UiElement } from '../schema/observation.js';
import type { ElementTarget } from '../schema/locator.js';

/**
 * The contract every surface implements.
 *
 * This interface is the entire generalization story. Nothing above it — not the agent
 * loop, not the artifact, not the replay engine, not the policy gate — mentions a
 * browser, a DOM, or a selector. A desktop provider backed by Windows UIA or macOS AX
 * implements the same five methods and everything downstream is unchanged.
 *
 * Note what is deliberately *not* here: there is no `querySelector`, no `evaluate`, no
 * escape hatch to the underlying technology. If a capability needed one, the abstraction
 * would be a lie and the artifact would stop being portable.
 */
export interface Surface {
  readonly kind: 'web' | 'desktop' | 'terminal';
  /** Identifies the perception provider in evidence, e.g. "web/dom-scan". */
  readonly providerId: string;

  /** Current state of the surface, as platform-independent elements plus text. */
  observe(): Promise<Observation>;

  /** A richer signal for evidence. PNG bytes. */
  screenshot(): Promise<Buffer>;

  /**
   * Resolve a target to concrete elements. Returns *all* candidates, not one, so the
   * caller can enforce its own ambiguity policy rather than having a first-match
   * heuristic buried in the driver.
   */
  resolve(target: ElementTarget, obs: Observation, bindings: Record<string, unknown>): Promise<ResolveResult>;

  /** Act on a resolved element. Coordinate-based, like a person would. */
  click(el: UiElement): Promise<void>;
  type(el: UiElement, text: string, clearFirst: boolean): Promise<void>;
  select(el: UiElement, value: string): Promise<void>;
  press(key: string): Promise<void>;
  navigate(url: string): Promise<void>;

  currentUrl(): Promise<string>;
  close(): Promise<void>;
}

export interface ResolveResult {
  candidates: UiElement[];
  /** Which rung of the cascade produced the candidates. Surfaced in the trace. */
  strategyUsed?: string;
  /** Index into the target's strategy list; higher means more degraded targeting. */
  strategyRank?: number;
  /** Every rung that was tried and what it returned, for debugging a miss. */
  attempts: Array<{ strategy: string; matched: number }>;
}
