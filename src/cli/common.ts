import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Allowlist, CapabilityArtifact, TenantOverlay } from '../schema/artifact.js';
import type { RecoveryRule } from '../schema/artifact.js';
import { BrowserSurface } from '../surface/browser/browserSurface.js';
import { PolicyGate } from '../policy/gate.js';
import { Redactor } from '../policy/redaction.js';
import { EvidenceRecorder } from '../evidence/recorder.js';
import { attachOrLaunch } from '../escalation/session.js';

export interface Args { [k: string]: string | boolean | string[] }

/** Minimal flag parser. `--k v`, `--flag`, and repeated `--input a=1 --input b=2`. */
export function parseArgs(argv = process.argv.slice(2)): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    const prev = out[key];
    if (prev === undefined) out[key] = next;
    else out[key] = Array.isArray(prev) ? [...prev, next] : [String(prev), next];
    i++;
  }
  return out;
}

export const str = (a: Args, k: string, d: string): string => (typeof a[k] === 'string' ? (a[k] as string) : d);
export const flag = (a: Args, k: string): boolean => a[k] === true || a[k] === 'true';
export const list = (a: Args, k: string): string[] => (a[k] === undefined ? [] : Array.isArray(a[k]) ? (a[k] as string[]) : [String(a[k])]);

/** `--input memberId=12345` pairs. */
export function inputPairs(a: Args): Record<string, string> {
  return Object.fromEntries(list(a, 'input').map(s => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  }));
}

export interface AppProfile {
  appId: string;
  appVersion: string;
  description: string;
  allowlist: Allowlist;
  recoveries: RecoveryRule[];
}

export const loadProfile = (p = 'profiles/portal.json'): AppProfile => JSON.parse(fs.readFileSync(p, 'utf8'));
export const loadArtifact = (p: string): CapabilityArtifact => JSON.parse(fs.readFileSync(p, 'utf8'));

export function loadOverlay(tenantId: string, capabilityId: string, explicit?: string): TenantOverlay | undefined {
  const file = explicit ?? path.join('artifacts', 'overlays', `${tenantId}.${capabilityId}.json`);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const baseUrlFor = (tenantId: string, host = 'http://localhost:5173'): string => `${host}/t/${tenantId}`;

/** One assembly point for surface + policy + evidence, shared by discovery and replay. */
export async function buildRuntime(opts: {
  kind: 'discovery' | 'replay';
  allowlist: Allowlist;
  providerId: string;
  headless: boolean;
}) {
  const runId = crypto.randomUUID().slice(0, 8);
  const redactor = new Redactor();
  const recorder = new EvidenceRecorder(runId, opts.kind, redactor);
  const { browser, page, ownsBrowser } = await attachOrLaunch({ headless: opts.headless });
  const surface = await BrowserSurface.attach(browser, page, opts.providerId, ownsBrowser);
  const gate = new PolicyGate(surface, opts.allowlist, redactor);
  return { runId, redactor, recorder, gate, surface, page, browser, ownsBrowser };
}

/** Arm a fault in the stand-in portal. Test-harness only; not part of the system. */
export async function injectFault(host: string, kind: string, count = 1, onRoute = '/member'): Promise<void> {
  if (!kind || kind === 'none') return;
  await fetch(`${host}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind, count: String(count), onRoute }),
  });
  console.log(`[harness] armed fault "${kind}" x${count} on route ${onRoute} of the stand-in portal`);
}

export async function resetFaults(host: string): Promise<void> {
  await fetch(`${host}/__reset`, { method: 'POST' }).catch(() => {});
}

export function printResultSummary(result: any): void {
  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('');
  console.log(`RESULT: ${String(result.status).toUpperCase()}`);
  line('capability', `${result.capabilityId}@${result.capabilityVersion}`);
  line('tenant', result.tenantId);
  line('duration', `${result.durationMs} ms`);
  line('evidence', result.evidenceDir);
  if (result.status === 'success') line('outputs', JSON.stringify(result.outputs));
  if (result.status === 'business_outcome') { line('code', result.code); line('message', result.message); line('at step', result.atStepId); }
  if (result.status === 'failure') {
    line('kind', result.kind); line('at step', result.atStepId ?? '(none)');
    line('expected', result.expected); line('observed', result.observed);
    if (result.remediation) line('remediation', result.remediation);
    if (result.screenshotPath) line('screenshot', result.screenshotPath);
  }
  if (result.status === 'escalated') {
    line('intervention', result.interventionId); line('reason', result.reason);
    line('at step', result.atStepId); line('resumable', result.resumable);
  }
  const drift = result.surfaceDrift;
  if (drift?.drifted) {
    line('drift', `surface fingerprint changed (recorded ${drift.recorded.slice(0, 6)}…, observed ${drift.observed.slice(0, 6)}…) — re-review this capability for this tenant`);
    if (result.surfaceDrift?.changedSteps?.length) for (const c of result.surfaceDrift.changedSteps) line('', `  ${c.stepId}: ${c.recorded} → ${c.observed}`);
  }
  console.log('');
  for (const t of result.trace ?? []) {
    console.log(`  ${t.status === 'ok' ? '✓' : t.status === 'recovered' ? '↻' : t.status === 'skipped' ? '⤼' : '✗'} ${String(t.stepId).padEnd(28)} ${t.locatorStrategyUsed ?? ''} ${t.recoveriesApplied?.length ? `[recovered: ${t.recoveriesApplied.join(',')}]` : ''}`);
  }
  console.log('');
}
