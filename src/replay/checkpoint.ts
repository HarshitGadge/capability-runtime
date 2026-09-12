import type { Assertion, Checkpoint } from '../schema/checkpoint.js';
import type { Observation } from '../schema/observation.js';
import { resolveTarget, resolveValue, textMatches } from '../surface/locatorResolver.js';

export interface CheckpointResult {
  passed: boolean;
  /** Per-assertion detail, so a failure names the clause that failed rather than the whole checkpoint. */
  details: Array<{ assertion: string; passed: boolean; observed: string }>;
}

const describe = (a: Assertion): string => {
  switch (a.kind) {
    case 'url_matches': return `url matches /${a.pattern}/`;
    case 'element_present': return `element present: ${a.target.semanticId}`;
    case 'element_absent': return `element absent: ${a.target.semanticId}`;
    case 'text_present': return `text present: ${JSON.stringify(a.text)}`;
    case 'text_absent': return `text absent: ${JSON.stringify(a.text)}`;
    case 'element_count': return `element count ${a.target.semanticId} in [${a.min ?? 0}, ${a.max ?? '∞'}]`;
  }
};

const allText = (obs: Observation) => Object.values(obs.textByFrame).join('\n');

function evaluateAssertion(a: Assertion, obs: Observation, bindings: Record<string, unknown>): { passed: boolean; observed: string } {
  switch (a.kind) {
    case 'url_matches': {
      // Any frame satisfies the assertion. On a frameset the screen that matters is
      // almost never the one in the address bar.
      const urls = [obs.url, ...Object.values(obs.urlByFrame ?? {})];
      const re = new RegExp(a.pattern, 'i');
      const hit = urls.find(u => re.test(u));
      return { passed: !!hit, observed: hit ?? urls.join(' , ') };
    }
    case 'element_present': {
      const r = resolveTarget(a.target, obs, bindings);
      return { passed: r.candidates.length > 0, observed: `${r.candidates.length} candidate(s) via ${r.strategyUsed ?? 'no strategy matched'}` };
    }
    case 'element_absent': {
      const r = resolveTarget(a.target, obs, bindings);
      return { passed: r.candidates.length === 0, observed: `${r.candidates.length} candidate(s)` };
    }
    case 'text_present': {
      const needle = resolveValue(a.text, bindings);
      const hay = allText(obs);
      const ok = textMatches(hay, needle, a.match);
      return { passed: ok, observed: ok ? `found "${needle}"` : `"${needle}" not in ${hay.length} chars of visible text` };
    }
    case 'text_absent': {
      const needle = resolveValue(a.text, bindings);
      const ok = !textMatches(allText(obs), needle, a.match);
      return { passed: ok, observed: ok ? `"${needle}" absent` : `"${needle}" unexpectedly present` };
    }
    case 'element_count': {
      const n = resolveTarget(a.target, obs, bindings).candidates.length;
      const ok = (a.min == null || n >= a.min) && (a.max == null || n <= a.max);
      return { passed: ok, observed: `${n}` };
    }
  }
}

export function evaluateCheckpoint(cp: Checkpoint, obs: Observation, bindings: Record<string, unknown>): CheckpointResult {
  const details = cp.all.map(a => ({ assertion: describe(a), ...evaluateAssertion(a, obs, bindings) }));
  return { passed: details.every(d => d.passed), details };
}

/**
 * Poll until the checkpoint holds or the budget runs out.
 *
 * This is the only waiting primitive in the system, and it is deliberately the only
 * one. There are no fixed sleeps and no "wait for network idle" anywhere in a replay:
 * every wait is a wait for a *stated condition about the screen*, which means the
 * artifact says what it is waiting for and a timeout can report what never became true.
 * A slow surface and a broken one are then distinguishable, which is the difference
 * between a retry and a hard failure.
 */
export async function waitForCheckpoint(
  cp: Checkpoint,
  observe: () => Promise<Observation>,
  bindings: Record<string, unknown>,
  onPoll?: (r: CheckpointResult, obs: Observation) => void,
): Promise<{ result: CheckpointResult; observation: Observation; waitedMs: number }> {
  const started = Date.now();
  let last: CheckpointResult = { passed: false, details: [] };
  let obs = await observe();
  for (;;) {
    last = evaluateCheckpoint(cp, obs, bindings);
    onPoll?.(last, obs);
    if (last.passed) return { result: last, observation: obs, waitedMs: Date.now() - started };
    if (Date.now() - started >= cp.timeoutMs) return { result: last, observation: obs, waitedMs: Date.now() - started };
    await new Promise(r => setTimeout(r, cp.pollMs));
    obs = await observe();
  }
}

export const failedClauses = (r: CheckpointResult): string =>
  r.details.filter(d => !d.passed).map(d => `${d.assertion} (observed: ${d.observed})`).join('; ') || '(none)';
