import { describe, it, expect, vi } from 'vitest';
import { PolicyGate, PolicyViolation, ConfirmationRequired } from '../src/policy/gate.js';
import { classifyRisk, riskExceeds } from '../src/policy/risk.js';
import { Redactor } from '../src/policy/redaction.js';
import type { Surface } from '../src/surface/surface.js';
import type { Allowlist } from '../src/schema/artifact.js';
import type { UiElement } from '../src/schema/observation.js';

vi.mock('../src/escalation/lease.js', () => ({ automationMayAct: () => true }));

const allowlist: Allowlist = {
  origins: ['http://localhost:5173'], pathPrefixes: ['/t/'],
  actions: ['navigate', 'click', 'type', 'extract', 'assert'], maxUnattendedRisk: 'elevated',
};

const el = (p: Partial<UiElement> = {}): UiElement => ({
  ref: 'r', role: 'button', name: 'Go', disabled: false, focusable: true,
  bounds: { x: 1, y: 1, width: 1, height: 1 }, frame: [], ...p,
});

function stub(url = 'http://localhost:5173/t/tenant-a/search') {
  const calls: string[] = [];
  const surface = {
    kind: 'web', providerId: 'test',
    observe: async () => ({ observedAt: '', url, title: '', elements: [], textByFrame: {}, urlByFrame: {}, provider: 'test', viewport: { width: 1, height: 1 } }),
    screenshot: async () => Buffer.alloc(0),
    resolve: async () => ({ candidates: [], attempts: [] }),
    click: async () => { calls.push('click'); },
    type: async (_e: UiElement, t: string) => { calls.push(`type:${t}`); },
    select: async () => { calls.push('select'); },
    press: async () => { calls.push('press'); },
    navigate: async (u: string) => { calls.push(`navigate:${u}`); url = u; },
    currentUrl: async () => url,
    close: async () => {},
  } as unknown as Surface;
  return { surface, calls };
}

describe('policy gate', () => {
  it('denies navigation outside the allowlisted origin', async () => {
    const { surface, calls } = stub();
    const gate = new PolicyGate(surface, allowlist, new Redactor());
    await expect(gate.navigate('http://evil.test/x')).rejects.toThrow(PolicyViolation);
    expect(calls).toEqual([]);
  });

  it('denies a path outside the allowed prefixes', async () => {
    const gate = new PolicyGate(stub().surface, allowlist, new Redactor());
    await expect(gate.navigate('http://localhost:5173/admin')).rejects.toThrow(/PATH_NOT_ALLOWED|Path/);
  });

  it('re-checks the URL after a click, because a link can navigate off the allowlist', async () => {
    const { surface } = stub();
    const gate = new PolicyGate(surface, allowlist, new Redactor());
    (surface as any).click = async () => { (surface as any).currentUrl = async () => 'http://evil.test/'; };
    await expect(gate.click(el())).rejects.toThrow(PolicyViolation);
  });

  it('denies an action verb the capability never declared', async () => {
    const gate = new PolicyGate(stub().surface, allowlist, new Redactor());
    await expect(gate.select(el(), 'x')).rejects.toThrow(/ACTION_NOT_ALLOWED|not in this capability/);
  });

  it('routes an above-ceiling step for confirmation instead of performing it', async () => {
    const { surface, calls } = stub();
    const gate = new PolicyGate(surface, allowlist, new Redactor());
    gate.withContext({ risk: 'irreversible', stepId: 's1', intent: 'Submit the opening' });
    await expect(gate.click(el())).rejects.toThrow(ConfirmationRequired);
    expect(calls).toEqual([]);
  });

  it('blocks outright rather than escalating when no human channel exists', async () => {
    const gate = new PolicyGate(stub().surface, allowlist, new Redactor(), false);
    gate.withContext({ risk: 'irreversible', stepId: 's1', intent: 'x' });
    await expect(gate.click(el())).rejects.toThrow(PolicyViolation);
  });

  it('spends a human authorization exactly once', async () => {
    const { surface, calls } = stub();
    const gate = new PolicyGate(surface, allowlist, new Redactor());
    gate.withContext({ risk: 'irreversible', stepId: 's1', intent: 'x' });
    gate.authorizeOnce('s1');
    await gate.click(el());
    expect(calls).toEqual(['click']);
    // A second attempt at the same step must stop again: approval is not a standing grant.
    await expect(gate.click(el())).rejects.toThrow(ConfirmationRequired);
  });

  it('substitutes a redaction token back to its real value at the boundary', async () => {
    const { surface, calls } = stub();
    const redactor = new Redactor();
    const token = redactor.redact('4718355901');
    const gate = new PolicyGate(surface, allowlist, redactor);
    await gate.type(el({ role: 'textbox' }), token, true);
    expect(calls).toEqual(['type:4718355901']);
  });
});

describe('risk classification', () => {
  it('treats an account opening as irreversible from its label alone', () => {
    expect(classifyRisk({ kind: 'click' }, el({ name: 'Open Account' }))).toBe('irreversible');
    expect(classifyRisk({ kind: 'click' }, el({ name: 'Transfer Funds' }))).toBe('irreversible');
  });
  it('treats navigation and reads as safe', () => {
    expect(classifyRisk({ kind: 'click' }, el({ role: 'link', name: 'View' }))).toBe('safe');
    expect(classifyRisk({ kind: 'extract', extracts: [{ name: 'x', from: 'text', transform: 'trim' }] })).toBe('safe');
  });
  it('treats a plain search submit as safe and form entry as elevated', () => {
    expect(classifyRisk({ kind: 'click' }, el({ name: 'Search' }))).toBe('safe');
    expect(classifyRisk({ kind: 'type', value: { kind: 'const', value: 'x' }, clearFirst: true }, el())).toBe('elevated');
  });
  it('orders the classes', () => {
    expect(riskExceeds('irreversible', 'elevated')).toBe(true);
    expect(riskExceeds('safe', 'safe')).toBe(false);
  });
});
