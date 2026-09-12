import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import type Anthropic from '@anthropic-ai/sdk';
import { discover, detectDeadEnd, type ModelClient, type TurnRecord } from '../src/agent/discover.js';
import { compile, assertNoRegulatedData } from '../src/agent/compiler.js';
import { ReplayEngine } from '../src/replay/engine.js';
import { stabilize } from '../src/replay/preflight.js';
import { BrowserSurface } from '../src/surface/browser/browserSurface.js';
import { PolicyGate } from '../src/policy/gate.js';
import { Redactor } from '../src/policy/redaction.js';
import { EvidenceRecorder } from '../src/evidence/recorder.js';
import { CapabilityArtifact } from '../src/schema/artifact.js';
import fs from 'node:fs';

/**
 * The discovery loop, exercised end to end without a model.
 *
 * A scripted stand-in plays the model: it reads the rendered screen the loop sent back,
 * picks refs the way a model would (from the `[N] role "label"` lines), and returns
 * canned tool calls in sequence. Everything else is real — the browser, the portal, the
 * policy gate, the recorder, the compiler, the replay engine. So what is being proved is
 * that the loop's mechanics are correct: phase switching, ref resolution, recording only
 * during the record phase, and that what gets recorded compiles into an artifact that
 * actually replays. The only thing a real run adds on top is the model's judgement.
 */
const PORT = 5198;
const HOST = `http://localhost:${PORT}`;
const BASE = `${HOST}/t/tenant-a`;
const profile = JSON.parse(fs.readFileSync('profiles/portal.json', 'utf8'));
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
  process.env.PORTAL_USER ??= 'svc.agent';
  process.env.PORTAL_PASS ??= 'demo';
  app = spawn('npx', ['tsx', 'app/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(HOST); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); app?.kill(); });

// ------------------------------------------------------------------ scripted model

type Turn = (screen: string) => Array<{ name: string; input: Record<string, unknown> }>;

/** Find a ref on the rendered screen by role and a label fragment, as a model would. */
function ref(screen: string, role: string, label: RegExp): string {
  const re = new RegExp(`^\\s*\\[(\\d+)\\] ${role}\\s+"([^"]*)"`, 'gm');
  for (const m of screen.matchAll(re)) if (label.test(m[2]!)) return m[1]!;
  throw new Error(`fake model: no ${role} matching ${label} on screen:\n${screen}`);
}

/** Sequence of canned turns. Each gets the latest screen text the loop sent. */
function scriptedClient(turns: Turn[]): ModelClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        client.calls++;
        // The last user message holds the screen: either the initial prompt or tool results.
        const last = params.messages.at(-1)!;
        const screen = typeof last.content === 'string'
          ? last.content
          : (last.content as any[]).map(b => (typeof b.content === 'string' ? b.content : '')).join('\n');
        const turn = turns[Math.min(i++, turns.length - 1)]!;
        const content = turn(screen).map((t, k) => ({ type: 'tool_use' as const, id: `t${client.calls}_${k}`, name: t.name, input: t.input }));
        return {
          id: `msg_${client.calls}`, type: 'message', role: 'assistant', model: params.model,
          content, stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 } as any,
        } as Anthropic.Message;
      },
    },
  };
  return client;
}

async function runtime() {
  const redactor = new Redactor();
  const recorder = new EvidenceRecorder(crypto.randomUUID().slice(0, 8), 'discovery', redactor, 'evidence/.test');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const surface = await BrowserSurface.attach(browser, page, 'dom-scan', false);
  const gate = new PolicyGate(surface, { ...profile.allowlist, origins: [HOST] }, redactor);
  const close = async () => { recorder.close(); await context.close(); };
  return { redactor, recorder, gate, close };
}

const balanceFlow: Turn[] = [
  // explore: poke at the wrong thing first, then learn the not-found screen
  s => [{ name: 'click', input: { ref: ref(s, 'link', /Reports/), why: 'Look at reports' } }],
  s => [{ name: 'click', input: { ref: ref(s, 'link', /Member Lookup/), why: 'Return to member lookup' } }],
  s => [{ name: 'type_text', input: { ref: ref(s, 'textbox', /Member ID/), text: '99999', why: 'Try an identifier that will not exist' } }],
  s => [{ name: 'click', input: { ref: ref(s, 'button', /Search/), why: 'Submit the member search' } }],
  () => [{ name: 'declare_outcome', input: { code: 'MEMBER_NOT_FOUND', description: 'No member record matches the supplied identifier.', when_text_present: 'No member found' } }],
  // record
  () => [{ name: 'start_recording', input: {
    id: 'member.read_savings_balance', name: 'Read member savings balance',
    description: 'Look up a member by identifier and return the current savings balance.',
    inputs: [{ name: 'memberId', type: 'string', description: 'Member identifier', example: '12345', pattern: '^\\d{4,10}$' }],
    outputs: [{ name: 'savings_balance', type: 'currency', description: 'Current savings balance', sensitivity: 'regulated' }],
  } }],
  s => [{ name: 'type_text', input: { ref: ref(s, 'textbox', /Member ID/), text: '12345', why: 'Enter the member identifier in the lookup form' } }],
  s => [{ name: 'click', input: { ref: ref(s, 'button', /Search/), why: 'Submit the member search' } }],
  s => [{ name: 'click', input: { ref: ref(s, 'link', /^View$/), why: 'Open the matching member record from the results' } }],
  s => [{ name: 'extract_output', input: { ref: ref(s, 'cell', /«currency:/), output_name: 'savings_balance', transform: 'currency_to_number', why: 'Read the current savings balance from the member record' } }],
  () => [{ name: 'finish', input: { success_text: 'Member Detail', summary: 'done' } }],
];

// ------------------------------------------------------------------------- tests

describe('detectDeadEnd', () => {
  const t = (tool: string, input: unknown, screen: string): TurnRecord => ({ tool, input, screen });

  it('flags the same call repeated three times', () => {
    const h = [t('click', { ref: '3' }, 'a'), t('click', { ref: '3' }, 'b'), t('click', { ref: '3' }, 'c')];
    expect(detectDeadEnd(h)).toBe('repeated_action');
  });

  it('flags a screen that has not changed across six actions', () => {
    const h = Array.from({ length: 6 }, (_, i) => t('click', { ref: String(i) }, 'same'));
    expect(detectDeadEnd(h)).toBe('stagnant_screen');
  });

  it('does not flag progress', () => {
    const h = [t('click', { ref: '1' }, 'a'), t('click', { ref: '2' }, 'b'), t('click', { ref: '1' }, 'c'), t('type_text', { ref: '4', text: 'x' }, 'd')];
    expect(detectDeadEnd(h)).toBeNull();
  });

  it('is windowed: an old repeat does not poison a run that moved on', () => {
    const h = [t('click', { ref: '3' }, 'a'), t('click', { ref: '3' }, 'a'), t('click', { ref: '3' }, 'a'), t('click', { ref: '9' }, 'z')];
    expect(detectDeadEnd(h)).toBeNull();
  });
});

describe('discovery loop', () => {
  it('explores, records only after start_recording, compiles, and the artifact replays', async () => {
    const rt = await runtime();
    try {
      const client = scriptedClient(balanceFlow);
      const rec = await discover({
        goal: 'Look up member 12345 and read their current savings balance',
        entryPoint: `${BASE}/`, gate: rt.gate, recorder: rt.recorder, model: 'fake', maxSteps: 20, client,
        onEntry: async () => { await stabilize(rt.gate, profile.recoveries, { baseUrl: BASE }, rt.recorder); },
      });

      expect(rec.stopReason).toBe('goal_reached');
      expect(rec.declaredOutcomes.map(o => o.code)).toEqual(['MEMBER_NOT_FOUND']);
      expect(rec.capability?.id).toBe('member.read_savings_balance');
      // Exploration turns are not steps: only the four record-phase actions survive.
      expect(rec.actions.map(a => a.action.kind)).toEqual(['type', 'click', 'click', 'extract']);
      for (const a of rec.actions) {
        expect(a.element).toBeTruthy();
        expect(a.before.elements.length).toBeGreaterThan(0);
        expect(a.after.elements.length).toBeGreaterThan(0);
      }
      // The model saw a token where the balance was, and the loop still recorded the cell.
      expect(rec.actions[3]!.element!.proximityLabel).toBe('Savings Balance');

      const artifact = CapabilityArtifact.parse(compile({
        capability: rec.capability!, inputs: rec.inputs, outputs: rec.outputs, actions: rec.actions,
        successText: rec.successText, declaredOutcomes: rec.declaredOutcomes,
        profile: { ...profile, baseUrl: BASE },
        provenance: { discoveryModel: 'fake', discoveryRunId: 'test', tenantId: 'tenant-a', evidenceDir: rt.recorder.relDir() },
      }));
      expect(() => assertNoRegulatedData(artifact)).not.toThrow();
      expect(artifact.steps).toHaveLength(4);
      expect(artifact.steps[0]!.action).toMatchObject({ kind: 'type', value: { kind: 'input', name: 'memberId' } });
      expect(artifact.businessOutcomes[0]!.code).toBe('MEMBER_NOT_FOUND');

      // Evidence: the transcript and recording exist, and neither holds the balance.
      const dir = rt.recorder.dir;
      expect(fs.existsSync(`${dir}/transcript.json`)).toBe(true);
      expect(fs.readFileSync(`${dir}/recording.json`, 'utf8')).not.toContain('18,204.37');
      expect(fs.readFileSync(`${dir}/transcript.json`, 'utf8')).not.toContain('18,204.37');

      // The real proof: the artifact that came out of the loop runs without it.
      const rt2 = await runtime();
      try {
        const result = await new ReplayEngine({
          artifact, baseUrl: BASE, tenantId: 'tenant-a', inputs: { memberId: '12345' },
          gate: rt2.gate, recorder: rt2.recorder,
        }).run();
        expect(result.status).toBe('success');
        expect((result as any).outputs.savings_balance).toBe(18204.37);

        const miss = await new ReplayEngine({
          artifact, baseUrl: BASE, tenantId: 'tenant-a', inputs: { memberId: '99999' },
          gate: rt2.gate, recorder: rt2.recorder,
        }).run();
        expect(miss.status).toBe('business_outcome');
        expect((miss as any).code).toBe('MEMBER_NOT_FOUND');
      } finally { await rt2.close(); }
    } finally { await rt.close(); }
  }, 120_000);

  it('tells the model when a ref is stale instead of acting on the wrong control', async () => {
    const rt = await runtime();
    try {
      let sawError = false;
      const client = scriptedClient([
        () => [{ name: 'click', input: { ref: '999', why: 'Click something that is not there' } }],
        s => { sawError = /No control \[999\]/.test(s); return [{ name: 'finish', input: { success_text: 'x', summary: 'x' } }]; },
      ]);
      const rec = await discover({ goal: 'g', entryPoint: `${BASE}/`, gate: rt.gate, recorder: rt.recorder, model: 'fake', maxSteps: 5, client });
      expect(sawError).toBe(true);
      expect(rec.actions).toHaveLength(0);
    } finally { await rt.close(); }
  }, 60_000);

  it('stops on the wall-clock budget with a stop reason rather than hanging', async () => {
    const rt = await runtime();
    try {
      // A model that never finishes: it just keeps asking to observe.
      const client = scriptedClient([() => [{ name: 'observe', input: {} }]]);
      const rec = await discover({ goal: 'g', entryPoint: `${BASE}/`, gate: rt.gate, recorder: rt.recorder, model: 'fake', maxSteps: 50, timeoutMs: 1, client });
      expect(rec.stopReason).toBe('timeout');
      expect(rec.turns).toBeLessThan(50);
    } finally { await rt.close(); }
  }, 60_000);

  it('stops at a dead end when the model keeps repeating itself', async () => {
    const rt = await runtime();
    try {
      const client = scriptedClient([s => [{ name: 'click', input: { ref: ref(s, 'link', /Reports/), why: 'again' } }]]);
      const rec = await discover({ goal: 'g', entryPoint: `${BASE}/`, gate: rt.gate, recorder: rt.recorder, model: 'fake', maxSteps: 50, client,
        onEntry: async () => { await stabilize(rt.gate, profile.recoveries, { baseUrl: BASE }, rt.recorder); } });
      expect(rec.stopReason).toBe('dead_end');
      expect(client.calls).toBeLessThanOrEqual(4);
    } finally { await rt.close(); }
  }, 60_000);

  it('stops at max steps', async () => {
    const rt = await runtime();
    try {
      let n = 0;
      const client = scriptedClient([s => [{ name: 'click', input: { ref: ref(s, 'link', n++ % 2 ? /Reports/ : /Member Lookup/), why: 'wander' } }]]);
      const rec = await discover({ goal: 'g', entryPoint: `${BASE}/`, gate: rt.gate, recorder: rt.recorder, model: 'fake', maxSteps: 3, client,
        onEntry: async () => { await stabilize(rt.gate, profile.recoveries, { baseUrl: BASE }, rt.recorder); } });
      expect(rec.stopReason).toBe('max_steps');
      expect(rec.turns).toBe(3);
    } finally { await rt.close(); }
  }, 60_000);
});
