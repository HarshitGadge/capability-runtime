import { describe, it, expect } from 'vitest';
import { resolveTarget, textMatches, resolveValue } from '../src/surface/locatorResolver.js';
import type { Observation, UiElement } from '../src/schema/observation.js';
import type { ElementTarget } from '../src/schema/locator.js';

const el = (p: Partial<UiElement>): UiElement => ({
  ref: p.ref ?? 'r', role: 'button', name: '', disabled: false, focusable: true,
  bounds: { x: 0, y: 0, width: 10, height: 10 }, frame: [], ...p,
});

const obs = (elements: UiElement[]): Observation => ({
  observedAt: '', url: 'http://x/t/a/search', title: '', elements,
  textByFrame: { '(top)': '' }, urlByFrame: { '(top)': 'http://x/t/a/search' },
  provider: 'test', viewport: { width: 1280, height: 900 },
});

const target = (strategies: ElementTarget['strategies'], extra: Partial<ElementTarget> = {}): ElementTarget => ({
  semanticId: 't', description: 'd', strategies, frame: [], ambiguity: 'require_unique', ...extra,
});

describe('locator cascade', () => {
  it('stops at the highest rung that matches and reports which one won', () => {
    const r = resolveTarget(
      target([
        { kind: 'role_name', role: 'button', name: 'Search', match: 'normalized' },
        { kind: 'ordinal', role: 'button', index: 0 },
      ]),
      obs([el({ role: 'button', name: 'Search' }), el({ ref: 'r2', role: 'button', name: 'Cancel' })]),
      {},
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.strategyUsed).toBe('role_name(button, "Search")');
    expect(r.strategyRank).toBe(0);
  });

  it('falls to a lower rung only when every rung above it finds nothing', () => {
    const r = resolveTarget(
      target([
        { kind: 'role_name', role: 'button', name: 'Find Member', match: 'normalized' },
        { kind: 'ordinal', role: 'button', index: 0 },
      ]),
      obs([el({ role: 'button', name: 'Search' })]),
      {},
    );
    expect(r.strategyUsed).toBe('ordinal(button[0])');
    // The degradation is visible in the trace rather than silent, which is the point.
    expect(r.attempts.map(a => a.matched)).toEqual([0, 1]);
  });

  it('finds a legacy control that has no accessible name, via its layout label', () => {
    const r = resolveTarget(
      target([{ kind: 'proximity_label', role: 'textbox', label: 'Member ID', match: 'normalized' }]),
      obs([el({ role: 'textbox', name: '', proximityLabel: 'Member ID' })]),
      {},
    );
    expect(r.candidates).toHaveLength(1);
  });

  it('never lets a label cell match a proximity lookup for the value beside it', () => {
    // On a provider where a cell's accessible name is its text, the label cell itself
    // would otherwise satisfy proximity_label(cell, "Savings Balance") and the extraction
    // would return the label instead of the balance.
    const r = resolveTarget(
      target([{ kind: 'proximity_label', role: 'cell', label: 'Savings Balance', match: 'normalized' }]),
      obs([
        el({ ref: 'label', role: 'cell', name: 'Savings Balance', text: 'Savings Balance' }),
        el({ ref: 'value', role: 'cell', name: '$1.00', text: '$1.00', proximityLabel: 'Savings Balance' }),
      ]),
      {},
    );
    expect(r.candidates.map(c => c.ref)).toEqual(['value']);
  });

  it('scopes to the row carrying a caller-supplied value rather than picking the first match', () => {
    const rows = [
      el({ ref: 'a', role: 'link', text: 'View', rowText: '10001 | A. Rivera | active | View' }),
      el({ ref: 'b', role: 'link', text: 'View', rowText: '12345 | J. Whitfield | active | View' }),
    ];
    const r = resolveTarget(
      target([{ kind: 'text', text: 'View', role: 'link', match: 'normalized' }],
        { scope: { kind: 'row_containing', text: { kind: 'input', name: 'memberId' } } }),
      obs(rows), { 'input.memberId': '12345' },
    );
    expect(r.candidates.map(c => c.ref)).toEqual(['b']);
  });

  it('returns every candidate so the caller can enforce its own ambiguity policy', () => {
    const r = resolveTarget(
      target([{ kind: 'text', text: 'View', role: 'link', match: 'normalized' }]),
      obs([el({ ref: 'a', role: 'link', text: 'View' }), el({ ref: 'b', role: 'link', text: 'View' })]),
      {},
    );
    expect(r.candidates).toHaveLength(2);
  });

  it('ignores disabled controls', () => {
    const r = resolveTarget(
      target([{ kind: 'role_name', role: 'button', name: 'Open Account', match: 'normalized' }]),
      obs([el({ role: 'button', name: 'Open Account', disabled: true })]),
      {},
    );
    expect(r.candidates).toHaveLength(0);
  });

  it('matches text ignoring case and whitespace, which restyling changes constantly', () => {
    expect(textMatches('  Sign   On ', 'sign on', 'normalized')).toBe(true);
    expect(textMatches('Sign On', 'sign', 'exact')).toBe(false);
  });
});

describe('value references', () => {
  it('resolves inputs and extracted values', () => {
    expect(resolveValue({ kind: 'input', name: 'memberId' }, { 'input.memberId': '12345' })).toBe('12345');
    expect(resolveValue({ kind: 'extracted', name: 'ref' }, { 'extracted.ref': 'CNF-1' })).toBe('CNF-1');
    expect(resolveValue({ kind: 'const', value: 7 }, {})).toBe('7');
  });

  it('throws rather than silently typing an empty secret', () => {
    delete process.env.__ABSENT_SECRET__;
    expect(() => resolveValue({ kind: 'secret', envVar: '__ABSENT_SECRET__' }, {})).toThrow(/not set/);
  });
});
