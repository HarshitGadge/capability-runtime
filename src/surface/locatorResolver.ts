import type { Observation, UiElement } from '../schema/observation.js';
import type { ElementTarget, LocatorStrategy, Scope, TextMatch, ValueRef } from '../schema/locator.js';
import type { ResolveResult } from './surface.js';

const INTERACTIVE = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'button', 'link']);

/** Whitespace- and case-insensitive comparison. Restyling changes spacing constantly. */
const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function textMatches(actual: string | undefined, expected: string, mode: TextMatch): boolean {
  const a = norm(actual), e = norm(expected);
  switch (mode) {
    case 'exact': return (actual ?? '').trim() === expected.trim();
    case 'contains': return a.includes(e);
    case 'regex': { try { return new RegExp(expected, 'i').test(actual ?? ''); } catch { return false; } }
    case 'normalized': return a === e;
  }
}

/** Resolve a ValueRef against the run's bindings. Kept pure so it is trivially testable. */
export function resolveValue(ref: ValueRef, bindings: Record<string, unknown>): string {
  switch (ref.kind) {
    case 'const': return String(ref.value);
    case 'input': return String(bindings[`input.${ref.name}`] ?? bindings[ref.name] ?? '');
    case 'extracted': return String(bindings[`extracted.${ref.name}`] ?? '');
    case 'secret': {
      const v = process.env[ref.envVar];
      if (v == null) throw new Error(`Secret ${ref.envVar} is not set in the environment`);
      return v;
    }
  }
}

function applyScope(elements: UiElement[], scope: Scope | undefined, bindings: Record<string, unknown>): UiElement[] {
  if (!scope) return elements;
  switch (scope.kind) {
    case 'row_containing': {
      const needle = resolveValue(scope.text, bindings);
      return elements.filter(e => norm(e.rowText).includes(norm(needle)));
    }
    case 'region':
      return elements.filter(e => textMatches(e.region, scope.name, 'contains'));
    case 'near_text': {
      const anchors = elements.filter(e => textMatches(e.text, scope.text, 'contains'));
      if (!anchors.length) return [];
      return elements.filter(e =>
        anchors.some(a => Math.hypot(e.bounds.x - a.bounds.x, e.bounds.y - a.bounds.y) <= scope.withinPx));
    }
  }
}

function matchStrategy(elements: UiElement[], s: LocatorStrategy): UiElement[] {
  switch (s.kind) {
    case 'role_name':
      return elements.filter(e => e.role === s.role && textMatches(e.name, s.name, s.match));
    case 'proximity_label':
      // A control that later gains a real accessible name should still match the label
      // it was recorded under, so interactive roles also match on `name`. Cells never do:
      // a cell's name *is* its content, and letting the label cell "Savings Balance" match
      // a lookup for the value beside it returns the label instead of the balance.
      return elements.filter(e => e.role === s.role &&
        (textMatches(e.proximityLabel, s.label, s.match) ||
         (INTERACTIVE.has(e.role) && textMatches(e.name, s.label, s.match))));
    case 'placeholder':
      return elements.filter(e => textMatches(e.placeholder, s.placeholder, s.match));
    case 'text':
      return elements.filter(e => (!s.role || e.role === s.role) &&
        (textMatches(e.text, s.text, s.match) || textMatches(e.name, s.text, s.match)));
    case 'test_id':
      return [];   // No test hooks exist on the target surface; kept so the schema is honest.
    case 'ordinal': {
      const ofRole = elements.filter(e => e.role === s.role);
      const hit = ofRole[s.index];
      return hit ? [hit] : [];
    }
    case 'coordinates': {
      // Never used to choose an element on its own — only to break a tie between
      // candidates that a higher rung already judged equivalent.
      return elements.filter(e =>
        Math.abs(e.bounds.x + e.bounds.width / 2 - s.x) < 25 &&
        Math.abs(e.bounds.y + e.bounds.height / 2 - s.y) < 25);
    }
  }
}

export function describeStrategy(s: LocatorStrategy): string {
  switch (s.kind) {
    case 'role_name': return `role_name(${s.role}, "${s.name}")`;
    case 'proximity_label': return `proximity_label(${s.role}, "${s.label}")`;
    case 'placeholder': return `placeholder("${s.placeholder}")`;
    case 'text': return `text("${s.text}"${s.role ? `, ${s.role}` : ''})`;
    case 'test_id': return `test_id(${s.attribute}=${s.value})`;
    case 'ordinal': return `ordinal(${s.role}[${s.index}])`;
    case 'coordinates': return `coordinates(${Math.round(s.x)},${Math.round(s.y)})`;
  }
}

/**
 * Walk the strategy cascade top-down and stop at the first rung that matches anything.
 *
 * Two properties matter here. First, a lower rung is only consulted when every rung
 * above it found nothing — so a restyled tenant that still exposes the same accessible
 * name never silently falls through to coordinates. Second, the rung that won is
 * reported in the result and recorded in the run trace, which makes targeting
 * degradation observable: a capability quietly sliding from `role_name` to `ordinal`
 * across a fleet is the earliest signal that a surface has drifted.
 */
export function resolveTarget(target: ElementTarget, obs: Observation, bindings: Record<string, unknown>): ResolveResult {
  const inFrame = obs.elements.filter(e =>
    target.frame.length === 0 ? true : e.frame.join('/') === target.frame.join('/'));
  const scoped = applyScope(inFrame, target.scope, bindings);
  const pool = scoped.length ? scoped : (target.scope ? [] : inFrame);

  const attempts: ResolveResult['attempts'] = [];
  for (const [rank, strategy] of target.strategies.entries()) {
    const hits = matchStrategy(pool, strategy).filter(e => !e.disabled || strategy.kind === 'coordinates');
    attempts.push({ strategy: describeStrategy(strategy), matched: hits.length });
    if (hits.length > 0) {
      return { candidates: hits, strategyUsed: describeStrategy(strategy), strategyRank: rank, attempts };
    }
  }
  return { candidates: [], attempts };
}
