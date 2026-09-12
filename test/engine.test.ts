import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { ReplayEngine } from '../src/replay/engine.js';
import { PolicyGate } from '../src/policy/gate.js';
import { Redactor } from '../src/policy/redaction.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { resolveTarget } from '../src/surface/locatorResolver.js';
import { screenShape, fingerprintOf } from '../src/agent/compiler.js';
import type { Surface } from '../src/surface/surface.js';
import type { Observation, UiElement } from '../src/schema/observation.js';
import type { CapabilityArtifact, RecoveryRule } from '../src/schema/artifact.js';
import type { Step } from '../src/schema/step.js';
import type { ElementTarget } from '../src/schema/locator.js';
import type { Escalator, HandoffResult } from '../src/escalation/escalator.js';

vi.mock('../src/escalation/lease.js', () => ({ automationMayAct: () => true }));

/**
 * Engine behaviour that the browser-backed integration suite cannot pin cheaply: the
 * ambiguity policies, recovery exhaustion, the per-step time budget, and drift. Each
 * case builds a tiny artifact and drives it through a scripted surface, so the whole
 * file runs in well under a second.
 */

const BASE = 'http://test.local/t/x';

const el = (p: Partial<UiElement>): UiElement => ({
  ref: p.ref ?? Math.random().toString(36).slice(2), role: 'button', name: '', disabled: false, focusable: true,
  bounds: { x: 0, y: 0, width: 10, height: 10 }, frame: [], ...p,
});

const obs = (text: string, elements: UiElement[]): Observation => ({
  observedAt: '', url: `${BASE}/screen`, title: '', elements,
  textByFrame: { '(top)': text }, urlByFrame: { '(top)': `${BASE}/screen` },
  provider: 'stub', viewport: { width: 1280, height: 900 },
});

/**
 * A surface with two screens: START (holding whatever controls the test wants) and DONE.
 * Clicking moves from one to the other unless the test swaps in its own click.
 */
function stubSurface(opts: { start: UiElement[]; done?: UiElement[]; click?: () => Promise<void> }) {
  let screen: 'start' | 'done' = 'start';
  const calls: string[] = [];
  const surface = {
    kind: 'web', providerId: 'stub',
    observe: async () => (screen === 'start' ? obs('START', opts.start) : obs('DONE', opts.done ?? [])),
    screenshot: async () => Buffer.alloc(0),
    resolve: async (t: ElementTarget, o: Observation, b: Record<string, unknown>) => resolveTarget(t, o, b),
    click: opts.click ?? (async () => { calls.push('click'); screen = 'done'; }),
    type: async () => { calls.push('type'); },
    select: async () => { calls.push('select'); },
    press: async () => { calls.push('press'); },
    navigate: async () => { calls.push('navigate'); screen = 'start'; },
    currentUrl: async () => `${BASE}/screen`,
    close: async () => {},
  } as unknown as Surface;
  return { surface, calls, reset: () => { screen = 'start'; } };
}

const text = (value: string) => ({ kind: 'text_present' as const, text: { kind: 'const' as const, value }, match: 'contains' as const });
const cp = (description: string, value: string, timeoutMs = 300) => ({ description, all: [text(value)], timeoutMs, pollMs: 20 });

const goTarget = (ambiguity: ElementTarget['ambiguity'] = 'require_unique'): ElementTarget => ({
  semanticId: 'screen.go', description: 'the Go button', frame: [], ambiguity,
  strategies: [{ kind: 'role_name', role: 'button', name: 'Go', match: 'normalized' }],
});

function artifact(over: { steps?: Step[]; recoveries?: RecoveryRule[]; fingerprint?: string } = {}): CapabilityArtifact {
  const step: Step = {
    id: 'press_go', intent: 'Press Go', action: { kind: 'click' }, target: goTarget(), risk: 'safe',
    postcondition: cp('done screen', 'DONE'), timeoutMs: 5000, maxAttempts: 1,
  };
  return {
    schemaVersion: '1.0.0',
    capability: { id: 'test.cap', version: '1.0.0', name: 't', description: 'd', tags: [] },
    target: {
      appId: 'a', appVersion: '1', surface: 'web', entryPoint: '{baseUrl}/screen',
      allowlist: { origins: ['http://test.local'], pathPrefixes: ['/'], actions: ['navigate', 'click', 'type', 'select', 'press', 'extract', 'assert'], maxUnattendedRisk: 'elevated' },
    },
    inputs: [], outputs: [],
    steps: over.steps ?? [step],
    success: cp('done', 'DONE'),
    businessOutcomes: [],
    recoveries: over.recoveries ?? [],
    provenance: { recordedAt: '', discoveryModel: 'stub', discoveryRunId: 'r', recordedAgainstTenant: 'x', evidenceDir: '', surfaceFingerprint: over.fingerprint ?? 'unknown' },
  };
}

function fakeEscalator(resolution: HandoffResult['resolution'] = 'abandoned') {
  const requests: Array<{ reason: string; stepId: string }> = [];
  const escalator = {
    request: async (ctx: { reason: string; stepId: string }) => {
      requests.push({ reason: ctx.reason, stepId: ctx.stepId });
      return { interventionId: 'INT-test', resolution, resumable: true, resumeToken: 'tok' } satisfies HandoffResult;
    },
  } as unknown as Escalator;
  return { escalator, requests };
}

async function run(a: CapabilityArtifact, surface: Surface, escalator?: Escalator) {
  const redactor = new Redactor();
  const recorder = new EvidenceRecorder(Math.random().toString(36).slice(2, 10), 'replay', redactor, path.join(os.tmpdir(), 'capability-runtime-tests'));
  const gate = new PolicyGate(surface, a.target.allowlist, redactor);
  try {
    return await new ReplayEngine({ artifact: a, baseUrl: BASE, tenantId: 'x', inputs: {}, gate, recorder, escalator }).run();
  } finally {
    recorder.close();
  }
}

const go = (ref: string) => el({ ref, role: 'button', name: 'Go' });

describe('ambiguity policy', () => {
  it('require_unique refuses to guess between two matches', async () => {
    const { surface, calls } = stubSurface({ start: [go('a'), go('b')] });
    const r = await run(artifact(), surface);
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('locator_ambiguous');
    expect(calls).not.toContain('click');
  });

  it('first takes the first match in document order', async () => {
    const { surface, calls } = stubSurface({ start: [go('a'), go('b')] });
    const step = { ...artifact().steps[0]!, target: goTarget('first') };
    const r = await run(artifact({ steps: [step] }), surface);
    expect(r.status).toBe('success');
    expect(calls).toContain('click');
  });

  it('escalate hands the choice to a person and names the candidates', async () => {
    const { surface, calls } = stubSurface({ start: [go('a'), go('b')] });
    const step = { ...artifact().steps[0]!, target: goTarget('escalate') };
    const { escalator, requests } = fakeEscalator();
    const r = await run(artifact({ steps: [step] }), surface, escalator);
    expect(r.status).toBe('escalated');
    expect(requests[0]!.stepId).toBe('press_go');
    expect(requests[0]!.reason).toMatch(/2 matched/);
    expect(calls).not.toContain('click');
  });

  it('escalate with no operator channel falls back to a locator_ambiguous failure', async () => {
    const { surface } = stubSurface({ start: [go('a'), go('b')] });
    const step = { ...artifact().steps[0]!, target: goTarget('escalate') };
    const r = await run(artifact({ steps: [step] }), surface);
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('locator_ambiguous');
    expect((r as any).observed).toMatch(/no escalation channel/);
  });
});

describe('recovery exhaustion', () => {
  /** A banner that is always on the DONE screen, so the postcondition never holds and the rule keeps firing. */
  const stickyBanner = (escalate: boolean): RecoveryRule => ({
    code: 'STICKY_BANNER', description: 'a banner that will not go away',
    detect: cp('banner showing', 'BANNER', 50),
    actions: [{ id: 'dismiss', intent: 'Dismiss', action: { kind: 'click' }, risk: 'safe', timeoutMs: 1000, maxAttempts: 1,
      target: { semanticId: 'banner.ok', description: 'OK', frame: [], ambiguity: 'first',
        strategies: [{ kind: 'role_name', role: 'button', name: 'OK', match: 'normalized' }] } }],
    maxAttempts: 1, then: 'retry_step', escalateOnExhaustion: escalate,
  });
  const bannerSurface = () => {
    const ok = el({ ref: 'ok', role: 'button', name: 'OK' });
    let clicks = 0;
    const s = {
      kind: 'web', providerId: 'stub',
      // Every screen shows the banner; the step's DONE text never appears.
      observe: async () => obs('START BANNER', [go('a'), ok]),
      screenshot: async () => Buffer.alloc(0),
      resolve: async (t: ElementTarget, o: Observation, b: Record<string, unknown>) => resolveTarget(t, o, b),
      click: async () => { clicks++; }, type: async () => {}, select: async () => {}, press: async () => {},
      navigate: async () => {}, currentUrl: async () => `${BASE}/screen`, close: async () => {},
    } as unknown as Surface;
    return { surface: s, clicks: () => clicks };
  };

  it('routes to a human once the rule is out of budget and asks for it', async () => {
    const { surface } = bannerSurface();
    const step = { ...artifact().steps[0]!, maxAttempts: 3 };
    const { escalator, requests } = fakeEscalator();
    const r = await run(artifact({ steps: [step], recoveries: [stickyBanner(true)] }), surface, escalator);
    expect(r.status).toBe('escalated');
    expect(requests[0]!.reason).toMatch(/STICKY_BANNER exhausted after 1 attempt/);
  });

  it('fails as recovery_exhausted when it should escalate but no channel exists', async () => {
    const { surface } = bannerSurface();
    const step = { ...artifact().steps[0]!, maxAttempts: 3 };
    const r = await run(artifact({ steps: [step], recoveries: [stickyBanner(true)] }), surface);
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('recovery_exhausted');
  });

  it('without the flag, an exhausted rule is ignored and the step fails on its own terms', async () => {
    const { surface } = bannerSurface();
    const step = { ...artifact().steps[0]!, maxAttempts: 2 };
    const { escalator, requests } = fakeEscalator();
    const r = await run(artifact({ steps: [step], recoveries: [stickyBanner(false)] }), surface, escalator);
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('postcondition_unmet');
    expect(requests).toHaveLength(0);
  });
});

describe('step time budget', () => {
  it('bounds a hung action and reports a timeout naming the budget', async () => {
    const { surface } = stubSurface({ start: [go('a')], click: () => new Promise(() => {}) });
    const step = { ...artifact().steps[0]!, timeoutMs: 60, maxAttempts: 1 };
    const r = await run(artifact({ steps: [step] }), surface);
    expect(r.status).toBe('failure');
    expect((r as any).kind).toBe('timeout');
    expect((r as any).expected).toContain('60 ms');
    expect(r.trace[0]!.attempts).toBe(1);
  });

  it('counts a timed-out attempt against the retry budget', async () => {
    let n = 0;
    // First click hangs; the second one lands. maxAttempts 2 → success on the retry.
    const { surface } = stubSurface({ start: [go('a')] });
    const hang = () => new Promise<void>(() => {});
    const original = (surface as any).click as () => Promise<void>;
    (surface as any).click = async () => (n++ === 0 ? hang() : original());
    const step = { ...artifact().steps[0]!, timeoutMs: 60, maxAttempts: 2 };
    const r = await run(artifact({ steps: [step] }), surface);
    expect(r.status).toBe('success');
    expect(r.trace[0]!.attempts).toBe(2);
  });
});

describe('surface drift', () => {
  const doneScreen = (extra: UiElement[] = []) => [el({ role: 'link', name: 'Back' }), ...extra];
  const recordedFingerprint = () => fingerprintOf([screenShape(obs('DONE', doneScreen()), '/t/x')]);

  it('reports no drift when the screens match the recording', async () => {
    const { surface } = stubSurface({ start: [go('a')], done: doneScreen() });
    const r = await run(artifact({ fingerprint: recordedFingerprint() }), surface);
    expect(r.status).toBe('success');
    expect(r.surfaceDrift).toMatchObject({ drifted: false, comparedSteps: 1, totalSteps: 1 });
    expect(r.surfaceDrift.observed).toBe(r.surfaceDrift.recorded);
  });

  it('flags drift when a screen has grown a control, without failing the run', async () => {
    const { surface } = stubSurface({ start: [go('a')], done: doneScreen([el({ role: 'button', name: 'New thing' })]) });
    const r = await run(artifact({ fingerprint: recordedFingerprint() }), surface);
    expect(r.status).toBe('success');
    expect(r.surfaceDrift.drifted).toBe(true);
    expect(r.surfaceDrift.observed).not.toBe(r.surfaceDrift.recorded);
  });

  it('declines to judge drift on a run that did not see every step', async () => {
    const { surface } = stubSurface({ start: [go('a'), go('b')], done: doneScreen() });
    const r = await run(artifact({ fingerprint: recordedFingerprint() }), surface);
    expect(r.status).toBe('failure');
    expect(r.surfaceDrift.drifted).toBeNull();
    expect(r.surfaceDrift.comparedSteps).toBe(0);
  });

  it('strips the tenant prefix, so the same product on another tenant is not drift', () => {
    const a = screenShape({ ...obs('x', [go('a')]), url: 'http://h/t/tenant-a/member?id=1', urlByFrame: { content: 'http://h/t/tenant-a/member?id=1' } }, '/t/tenant-a');
    const b = screenShape({ ...obs('x', [go('a')]), url: 'http://h/t/tenant-b/member?id=1', urlByFrame: { content: 'http://h/t/tenant-b/member?id=1' } }, '/t/tenant-b');
    expect(a).toBe(b);
  });
});
