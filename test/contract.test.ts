import { describe, it, expect } from 'vitest';
import { applyOverlay, validateInputs } from '../src/replay/prepare.js';
import { evaluateCheckpoint } from '../src/replay/checkpoint.js';
import { CapabilityArtifact, TenantOverlay } from '../src/schema/artifact.js';
import type { Observation } from '../src/schema/observation.js';
import fs from 'node:fs';

const artifact = CapabilityArtifact.parse(JSON.parse(fs.readFileSync('artifacts/member.read_savings_balance.json', 'utf8')));
const overlay = TenantOverlay.parse(JSON.parse(fs.readFileSync('artifacts/overlays/tenant-b.member.read_savings_balance.json', 'utf8')));

describe('tenant overlay', () => {
  const merged = applyOverlay(artifact, overlay);

  it('retargets only the controls the tenant renamed', () => {
    const field = merged.steps.find(s => s.target?.semanticId === 'member_lookup.member_id')!;
    expect(JSON.stringify(field.target!.strategies)).toContain('Member Number');
    const view = merged.steps.find(s => s.target?.semanticId === 'search_results.view')!;
    expect(JSON.stringify(view.target!.strategies)).toContain('View');   // reused unchanged
  });

  it('rewrites screen wording in checkpoints', () => {
    expect(JSON.stringify(merged.steps[0]!.precondition)).toContain('Find a Member');
    expect(JSON.stringify(merged.steps[0]!.precondition)).not.toContain('Member Lookup');
  });

  it('cannot add, remove or reorder steps — that is what stops overlays forking a capability', () => {
    expect(merged.steps.map(s => s.id)).toEqual(artifact.steps.map(s => s.id));
    expect(merged.capability.id).toBe(artifact.capability.id);
    expect(merged.target.allowlist).toEqual(artifact.target.allowlist);
  });

  it('refuses an overlay written for a different capability', () => {
    expect(() => applyOverlay(artifact, { ...overlay, capabilityId: 'something.else' })).toThrow(/Overlay is for/);
  });

  it('leaves the base artifact untouched', () => {
    expect(JSON.stringify(artifact.steps[0]!.precondition)).toContain('Member Lookup');
  });
});

describe('input contract', () => {
  it('rejects a malformed identifier before the browser is touched', () => {
    expect(validateInputs(artifact, { memberId: 'abc' })).toMatchObject({ observed: '"abc"' });
  });
  it('rejects a missing required input', () => {
    expect(validateInputs(artifact, {})).toMatchObject({ observed: 'missing' });
  });
  it('rejects inputs the capability never declared', () => {
    expect(validateInputs(artifact, { memberId: '12345', extra: 'x' })?.observed).toContain('extra');
  });
  it('accepts a well-formed call', () => {
    expect(validateInputs(artifact, { memberId: '12345' })).toBeNull();
  });
});

const obs = (text: string, url = 'http://x/t/a/member?id=1'): Observation => ({
  observedAt: '', url, title: '', elements: [],
  textByFrame: { content: text }, urlByFrame: { content: url },
  provider: 'test', viewport: { width: 1, height: 1 },
});

describe('checkpoints', () => {
  it('detects a business outcome by what the app actually says', () => {
    const rule = artifact.businessOutcomes.find(b => b.code === 'MEMBER_NOT_FOUND')!;
    expect(evaluateCheckpoint(rule.detect, obs('No member found for 99999'), {}).passed).toBe(true);
    expect(evaluateCheckpoint(rule.detect, obs('Member Detail'), {}).passed).toBe(false);
  });

  it('matches a URL in any frame, not just the address bar', () => {
    const cp = { description: '', all: [{ kind: 'url_matches' as const, pattern: '/member(\\?|$)' }], timeoutMs: 1, pollMs: 1 };
    expect(evaluateCheckpoint(cp, obs('x', 'http://x/t/a/member?id=1'), {}).passed).toBe(true);
    expect(evaluateCheckpoint(cp, obs('x', 'http://x/t/a/search'), {}).passed).toBe(false);
  });

  it('names the clause that failed rather than just failing', () => {
    const r = evaluateCheckpoint(artifact.success, obs('Search Results'), {});
    expect(r.passed).toBe(false);
    expect(r.details.some(d => !d.passed && d.assertion.includes('text present'))).toBe(true);
  });
});
