import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { ReplayEngine } from '../src/replay/engine.js';
import { BrowserSurface } from '../src/surface/browser/browserSurface.js';
import { PolicyGate } from '../src/policy/gate.js';
import { Redactor } from '../src/policy/redaction.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { CapabilityArtifact, TenantOverlay } from '../src/schema/artifact.js';
import type { ReplayResult } from '../src/schema/result.js';

/**
 * End-to-end tests against a real browser and a real server.
 *
 * These are the tests that actually matter: the unit tests pin the pieces, but the
 * claim being made — "a recorded artifact replays deterministically and classifies what
 * it finds" — is only testable by running it. The app is booted by the suite so the
 * whole thing is one command with no API key and no external service.
 */
const PORT = 5199;
const HOST = `http://localhost:${PORT}`;
let app: ChildProcess;
let browser: Browser;

const artifact = CapabilityArtifact.parse(JSON.parse(fs.readFileSync('artifacts/member.read_savings_balance.json', 'utf8')));
const overlayB = TenantOverlay.parse(JSON.parse(fs.readFileSync('artifacts/overlays/tenant-b.member.read_savings_balance.json', 'utf8')));

const arm = (kind: string, onRoute = '/member') =>
  fetch(`${HOST}/__control`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ kind, count: '1', onRoute }) });
const reset = () => fetch(`${HOST}/__reset`, { method: 'POST' });

beforeAll(async () => {
  process.env.PORTAL_USER ??= 'svc.agent';
  process.env.PORTAL_PASS ??= 'demo';
  app = spawn('npx', ['tsx', 'app/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(HOST); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  app?.kill();
});

async function replay(opts: { inputs: Record<string, string>; tenant?: string; overlay?: TenantOverlay; providerId?: string }): Promise<ReplayResult> {
  const tenant = opts.tenant ?? 'tenant-a';
  const baseUrl = `${HOST}/t/${tenant}`;
  const redactor = new Redactor();
  const recorder = new EvidenceRecorder(crypto.randomUUID().slice(0, 8), 'replay', redactor, 'evidence/.test');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const surface = await BrowserSurface.attach(browser, page, opts.providerId ?? 'dom-scan', false);
  const gate = new PolicyGate(surface, { ...artifact.target.allowlist, origins: [HOST] }, redactor);
  try {
    return await new ReplayEngine({
      artifact, overlay: opts.overlay, baseUrl, tenantId: tenant,
      inputs: opts.inputs, gate, recorder,
    }).run();
  } finally {
    recorder.close();
    await context.close();
  }
}

describe('deterministic replay', () => {
  it('completes the goal and returns the declared output', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' } });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.savings_balance).toBe(18204.37);
    // Every step should resolve at the top of its cascade on an undrifted surface.
    expect(r.trace.every(t => t.status === 'ok')).toBe(true);
    expect(r.trace.some(t => /ordinal|coordinates/.test(t.locatorStrategyUsed ?? ''))).toBe(false);
  }, 60_000);

  it('is repeatable: the same inputs give the same outputs', async () => {
    await reset();
    const a = await replay({ inputs: { memberId: '10001' } });
    const b = await replay({ inputs: { memberId: '10001' } });
    expect(a.status).toBe('success');
    expect(JSON.stringify((a as any).outputs)).toBe(JSON.stringify((b as any).outputs));
  }, 90_000);
});

describe('classifying what the app says', () => {
  it('returns a typed business outcome for a member that does not exist', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '99999' } });
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.code).toBe('MEMBER_NOT_FOUND');
    // It is a result, not a crash: the caller is told where it stopped and why.
    expect(r.atStepId).toBeTruthy();
  }, 60_000);

  it('distinguishes a permission denial from a missing record', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '55501' } });
    expect(r.status).toBe('business_outcome');
    expect((r as any).code).toBe('ACCESS_RESTRICTED');
  }, 60_000);

  it('rejects a malformed input before opening a browser page', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: 'not-a-member' } });
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('invalid_input');
    expect(r.trace).toHaveLength(0);
  }, 30_000);
});

describe('recovering from anticipated interruptions', () => {
  it('dismisses a blocking interstitial and carries on', async () => {
    await reset();
    await arm('interstitial', '/member');
    const r = await replay({ inputs: { memberId: '12345' } });
    expect(r.status).toBe('success');
    expect(r.trace.some(t => t.recoveriesApplied.includes('MAINTENANCE_INTERSTITIAL'))).toBe(true);
  }, 60_000);

  it('re-authenticates and restarts the flow when the session drops mid-run', async () => {
    await reset();
    await arm('session_timeout', '/member');
    const r = await replay({ inputs: { memberId: '12345' } });
    expect(r.status).toBe('success');
    expect(r.trace.some(t => t.recoveriesApplied.includes('SIGNED_OUT'))).toBe(true);
    // Restarting means earlier steps run twice; the trace should show that honestly.
    expect(r.trace.filter(t => t.stepId === 'submit_the_member_search').length).toBeGreaterThan(1);
  }, 90_000);

  it('survives a slow response without a fixed sleep anywhere', async () => {
    await reset();
    await arm('slow', '/member');
    const r = await replay({ inputs: { memberId: '12345' } });
    expect(r.status).toBe('success');
  }, 60_000);
});

describe('perception is swappable beneath the artifact', () => {
  it('replays the same artifact through the browser accessibility tree instead of the in-page scanner', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' }, providerId: 'cdp' });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs.savings_balance).toBe(18204.37);
    // Same rungs as the default provider: the legacy inputs were labelled from AX table
    // structure, not from the DOM, and the surface fingerprint agrees across providers.
    expect(r.trace.map(t => t.locatorStrategyUsed)).toEqual([
      'proximity_label(textbox, "Member ID")', 'role_name(button, "Search")',
      'role_name(link, "View")', 'proximity_label(cell, "Savings Balance")',
    ]);
    expect(r.surfaceDrift.drifted).toBe(false);
  }, 60_000);
});

describe('reuse across tenants running the same product', () => {
  it('reports precisely what drifted when the unspecialized capability meets a new skin', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' }, tenant: 'tenant-b' });
    expect(r.status).toBe('failure');
    if (r.status !== 'failure') return;
    expect(r.kind).toBe('precondition_unmet');
    // The diagnostic must name the literal that moved, or the fix is a guessing game.
    expect(r.expected).toContain('Member Lookup');
    expect(r.remediation).toMatch(/overlay/i);
  }, 60_000);

  it('runs the same artifact on the second tenant with a three-line overlay', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' }, tenant: 'tenant-b', overlay: overlayB });
    expect(r.status).toBe('success');
    expect((r as any).outputs.savings_balance).toBe(18204.37);
    expect(r.trace.map(t => t.locatorStrategyUsed)).toContain('proximity_label(textbox, "Member Number")');
  }, 60_000);
});

describe('evidence', () => {
  it('writes a structured run log and redacts regulated values in it', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' } });
    const log = fs.readFileSync(`${r.evidenceDir}/run.jsonl`, 'utf8');
    expect(log.split('\n').filter(Boolean).length).toBeGreaterThan(5);
    expect(log).toContain('"kind":"locator_resolved"');
    // The balance is returned to the caller in the clear and never written to disk —
    // in either its rendered form or the normalized number the regex cannot recognise.
    expect((r as any).outputs.savings_balance).toBe(18204.37);
    expect(log).not.toContain('18,204.37');
    expect(log).not.toContain('18204.37');
    expect(log).not.toContain('4718355901');
    expect(log).toContain('«withheld:currency»');
  }, 60_000);

  it('keeps an account number out of the observation snapshots too', async () => {
    await reset();
    const r = await replay({ inputs: { memberId: '12345' } });
    const snapshots = fs.readdirSync(`${r.evidenceDir}/observations`).filter(f => f.endsWith('.json'));
    for (const f of snapshots) {
      const body = fs.readFileSync(`${r.evidenceDir}/observations/${f}`, 'utf8');
      expect(body).not.toContain('4718355901');
    }
  }, 60_000);
});
