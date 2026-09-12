import { describe, it, expect } from 'vitest';
import { Redactor } from '../src/policy/redaction.js';
import { assertNoRegulatedData } from '../src/agent/compiler.js';
import type { CapabilityArtifact } from '../src/schema/artifact.js';

describe('redactor', () => {
  it('tokenizes account numbers, balances and identifiers', () => {
    const r = new Redactor();
    const out = r.redact('Savings Account 4718355901 balance $18,204.37 ssn 123-45-6789');
    expect(out).not.toContain('4718355901');
    expect(out).not.toContain('18,204.37');
    expect(out).not.toContain('123-45-6789');
    expect(out).toMatch(/«account:[0-9a-f]{6}»/);
  });

  it('leaves instructional amounts below the threshold alone', () => {
    // "$25.00" in help text is not member data; a four-figure balance is. The line is a
    // configuration choice and this test pins where it currently sits.
    expect(new Redactor().redact('minimum $25.00')).toBe('minimum $25.00');
  });

  it('is stable per value, so the model can reason about what it cannot read', () => {
    const r = new Redactor();
    const a = r.redact('acct 4718355901'), b = r.redact('see 4718355901 again');
    const token = a.match(/«account:[0-9a-f]{6}»/)![0];
    expect(b).toContain(token);
  });

  it('reverses only in process, so a value can re-enter the page without leaving it', () => {
    const r = new Redactor();
    expect(r.reveal(r.redact('4718355901'))).toBe('4718355901');
  });

  it('redacts nested structures, not just top-level strings', () => {
    const r = new Redactor();
    const out = r.redactDeep({ rows: [{ cell: 'balance $18,204.37' }] });
    expect(JSON.stringify(out)).not.toContain('18,204.37');
  });
});

describe('artifact leak guard', () => {
  const base = (): CapabilityArtifact => JSON.parse(JSON.stringify({
    schemaVersion: '1.0.0',
    capability: { id: 'c', version: '1.0.0', name: 'n', description: 'd', tags: [] },
    target: { appId: 'a', appVersion: '1', surface: 'web', entryPoint: '{baseUrl}/', allowlist: { origins: ['http://x'], pathPrefixes: ['/'], actions: ['click'], maxUnattendedRisk: 'elevated' } },
    inputs: [], outputs: [], steps: [], businessOutcomes: [], recoveries: [],
    success: { description: 's', all: [], timeoutMs: 1, pollMs: 1 },
    provenance: { recordedAt: '', discoveryModel: '', discoveryRunId: '', recordedAgainstTenant: '', evidenceDir: '', surfaceFingerprint: '' },
  }));

  it('accepts an artifact built only from labels', () => {
    const a = base();
    a.success.all = [{ kind: 'text_present', text: { kind: 'const', value: 'Member Detail' }, match: 'contains' }];
    expect(() => assertNoRegulatedData(a)).not.toThrow();
  });

  it('refuses to emit an artifact that embedded a balance in a checkpoint', () => {
    const a = base();
    a.success.all = [{ kind: 'text_present', text: { kind: 'const', value: '$18,204.37' }, match: 'contains' }];
    expect(() => assertNoRegulatedData(a)).toThrow(/regulated data/);
  });

  it('refuses an artifact that embedded an account number in a locator', () => {
    const a = base();
    a.steps = [{ id: 's', intent: 'i', action: { kind: 'click' }, risk: 'safe', timeoutMs: 1, maxAttempts: 1,
      target: { semanticId: 'x', description: 'd', frame: [], ambiguity: 'require_unique',
        strategies: [{ kind: 'text', text: '4718355901', match: 'normalized' }] } }] as any;
    expect(() => assertNoRegulatedData(a)).toThrow(/account/);
  });
});
