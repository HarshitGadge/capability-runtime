import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import type { PolicyGate } from '../policy/gate.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Observation, UiElement } from '../schema/observation.js';
import type { ParamSpec, OutputSpec } from '../schema/artifact.js';
import { renderObservation } from './render.js';
import { TOOLS, SYSTEM_PROMPT } from './tools.js';
import type { RecordedAction } from './compiler.js';

/**
 * The slice of the Anthropic client the loop actually uses. Narrow on purpose: it is what
 * lets a test drive the loop with a scripted stand-in and prove the mechanics — phase
 * switching, ref resolution, recording, compilation — without a model or a key.
 */
export interface ModelClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export type StopReason = 'goal_reached' | 'max_steps' | 'timeout' | 'dead_end' | 'model_declined';

export interface DiscoveryOptions {
  goal: string;
  entryPoint: string;
  gate: PolicyGate;
  recorder: EvidenceRecorder;
  model: string;
  maxSteps: number;
  /** Wall-clock budget for the whole run. A loop that cannot finish should say so, not hang. */
  timeoutMs?: number;
  client?: ModelClient;
  /**
   * Run after every navigation to the entry point, before the model sees anything.
   * This is where session establishment happens, so the recorded capability contains
   * the business flow and not the login form.
   */
  onEntry?: () => Promise<void>;
}

export interface DiscoveryRecording {
  goal: string;
  model: string;
  capability: { id: string; name: string; description: string } | null;
  inputs: ParamSpec[];
  outputs: OutputSpec[];
  actions: RecordedAction[];
  declaredOutcomes: Array<{ code: string; description: string; whenTextPresent: string }>;
  successText: string;
  summary: string;
  turns: number;
  stopReason: StopReason;
}

/** One entry per action turn, for dead-end detection. */
export interface TurnRecord {
  tool: string;
  input: unknown;
  /** Rendered screen after the action. */
  screen: string;
}

/**
 * Dead-end detection, kept pure so it can be tested without a browser.
 *
 * Two shapes of stuck. The model re-issues the identical call — same tool, same input —
 * which means it is not learning from the result. Or it keeps acting and the screen never
 * changes, which means the surface is not responding to what it is doing. Either way, the
 * next turn is very unlikely to be the one that works, and every turn costs money.
 */
export function detectDeadEnd(history: TurnRecord[], opts = { repeats: 3, stagnantTurns: 6 }): 'repeated_action' | 'stagnant_screen' | null {
  if (history.length >= opts.repeats) {
    const tail = history.slice(-opts.repeats);
    const key = (t: TurnRecord) => `${t.tool}:${JSON.stringify(t.input)}`;
    if (tail.every(t => key(t) === key(tail[0]!))) return 'repeated_action';
  }
  if (history.length >= opts.stagnantTurns) {
    const tail = history.slice(-opts.stagnantTurns);
    if (tail.every(t => t.screen === tail[0]!.screen)) return 'stagnant_screen';
  }
  return null;
}

/**
 * The LLM-driven discovery loop: observe, decide, act, against the live surface.
 *
 * Three choices worth defending.
 *
 * The model acts through the same policy gate the replay engine uses, so an exploring
 * agent cannot wander off the allowlist or fire an irreversible control just because it
 * is curious. Guardrails that only apply to production are guardrails that were never
 * tested.
 *
 * Exploration and recording are separate phases. The first pass through an unfamiliar
 * UI is full of back-tracking; recording that verbatim produces an artifact that
 * faithfully reproduces someone's confusion. Making the model commit — "you know the
 * path now, do it once cleanly" — is what makes the captured flow minimal.
 *
 * The full transcript is written to evidence as it goes, and the recording is saved
 * separately. The artifact can then be recompiled from that recording offline, with no
 * API call, which is both a cost control while iterating on the schema and the direct
 * demonstration that the artifact is decoupled from the model transcript.
 */
export async function discover(opts: DiscoveryOptions): Promise<DiscoveryRecording> {
  const { gate, recorder, goal, entryPoint } = opts;
  const client: ModelClient = opts.client ?? new Anthropic();
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);

  const rec: DiscoveryRecording = {
    goal, model: opts.model, capability: null, inputs: [], outputs: [],
    actions: [], declaredOutcomes: [], successText: '', summary: '', turns: 0,
    stopReason: 'max_steps',
  };

  let phase: 'explore' | 'record' = 'explore';
  let index = new Map<string, UiElement>();
  const history: TurnRecord[] = [];

  await gate.withContext({ risk: 'safe', stepId: 'entry', intent: 'Open the application entry point' }).navigate(entryPoint);
  await opts.onEntry?.();

  // The model sees the redacted rendering; the recording keeps the real element. Both
  // are projections of the same observation, joined by `ref`, so a control the model
  // picked as "[17] cell «currency:25fe2a»" is stored as the cell reading the balance —
  // and the compiler's uniqueness check then compares like with like. Indexing the
  // redacted element instead silently strips every semantic locator off any control
  // whose text was tokenized, leaving only coordinates.
  const screen = async (): Promise<string> => {
    const obs = await gate.observe();
    const rendered = renderObservation(gate.redactor.redactDeep(obs, 'llm'));
    index = new Map([...rendered.index].map(([ref, redacted]) => [ref, obs.elements.find(e => e.ref === redacted.ref) ?? redacted]));
    return rendered.text;
  };

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `GOAL: ${goal}\n\nEntry point: ${entryPoint}\n\nCurrent screen:\n\n${await screen()}` },
  ];

  const transcriptPath = `${recorder.dir}/transcript.json`;
  const saveTranscript = () => fs.writeFileSync(transcriptPath, JSON.stringify(messages, null, 2));

  for (let turn = 0; turn < opts.maxSteps; turn++) {
    rec.turns = turn + 1;

    if (Date.now() > deadline) {
      rec.stopReason = 'timeout';
      recorder.event('note', { message: `discovery stopped: wall-clock budget exhausted after ${turn} turns` });
      break;
    }
    const deadEnd = detectDeadEnd(history);
    if (deadEnd) {
      rec.stopReason = 'dead_end';
      recorder.event('note', { message: `discovery stopped: dead end (${deadEnd}) after ${turn} turns` });
      break;
    }

    const response = await client.messages.create({
      model: opts.model,
      // Thinking tokens count against this, so leave headroom rather than truncating a turn.
      max_tokens: 16000,
      // Stable prefix cached: the system prompt and tool list never change across the
      // run, so every turn after the first reads them instead of re-paying for them.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      thinking: { type: 'adaptive' },
      messages,
    });

    recorder.event('llm_response', {
      turn, stop_reason: response.stop_reason,
      usage: response.usage,
      text: response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join(' ').slice(0, 500),
    });

    if (response.stop_reason === 'refusal') {
      rec.stopReason = 'model_declined';
      recorder.event('note', { message: `model declined the task: ${JSON.stringify(response.stop_details)}` });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });
    saveTranscript();

    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) {
      messages.push({ role: 'user', content: 'Continue by calling a tool. If the goal is recorded, call finish.' });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let done = false;

    for (const call of calls) {
      const input = call.input as any;
      recorder.event('llm_tool_call', { turn, tool: call.name, input, phase });

      try {
        if (call.name === 'finish') {
          rec.successText = input.success_text;
          // Deliberately not stored: the model's free-text summary can recall specific
          // values (a confirmation number, a name) from its context that no label-driven
          // scrub can locate. The structured step trace is the record of what happened.
          rec.summary = `Recorded ${rec.actions.length}-step capability for: ${goal}`;
          input.summary = '«not persisted: model free-text»';
          rec.stopReason = 'goal_reached';
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded. Run complete.' });
          done = true;
          break;
        }

        if (call.name === 'declare_outcome') {
          rec.declaredOutcomes.push({ code: input.code, description: input.description, whenTextPresent: input.when_text_present });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `Declared business outcome ${input.code}.` });
          continue;
        }

        if (call.name === 'start_recording') {
          phase = 'record';
          rec.capability = { id: input.id, name: input.name, description: input.description };
          rec.inputs = (input.inputs ?? []).map((i: any): ParamSpec => ({
            name: i.name, type: i.type, required: true, description: i.description,
            sensitivity: i.sensitivity ?? 'internal', pattern: i.pattern, example: String(i.example),
          }));
          rec.outputs = (input.outputs ?? []).map((o: any): OutputSpec => ({
            name: o.name, type: o.type, description: o.description,
            sensitivity: o.sensitivity ?? 'regulated', required: true,
          }));
          rec.actions = [];
          await gate.withContext({ risk: 'safe', stepId: 'record_reset', intent: 'Return to the entry point to record' }).navigate(entryPoint);
          await opts.onEntry?.();
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `Recording. Session reset to the entry point. Perform the flow cleanly.\n\n${await screen()}` });
          continue;
        }

        // --- surface actions -------------------------------------------------
        const before = await gate.observe();
        const el = input.ref ? index.get(String(input.ref)) : undefined;
        if (input.ref && !el) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No control [${input.ref}] on the current screen. Re-read the screen and use a current ref.\n\n${await screen()}` });
          continue;
        }

        gate.withContext({ risk: 'safe', stepId: `discovery_${turn}`, intent: input.why ?? call.name });

        switch (call.name) {
          case 'observe': break;
          case 'navigate': await gate.navigate(input.url); break;
          case 'click': await gate.click(el!); break;
          case 'type_text': await gate.type(el!, input.text, true); break;
          case 'select_option': await gate.select(el!, input.value); break;
          case 'press_key': await gate.press(input.key); break;
          case 'extract_output': break;
          default:
            results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` });
            continue;
        }

        const after = await gate.observe();

        if (phase === 'record' && call.name !== 'observe') {
          rec.actions.push({
            intent: input.why ?? call.name,
            element: el,
            before, after,
            action: toAction(call.name, input),
          });
        }

        await recorder.screenshot(gate, `t${turn}-${call.name}`);
        const text = await screen();
        // Refs are per-observation, so the same screen renders identically turn to turn;
        // that is what makes "the screen has not changed" detectable by string equality.
        if (call.name !== 'observe') history.push({ tool: call.name, input, screen: text });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recorder.event('note', { message: `tool ${call.name} failed: ${message}` });
        const shown = await screen();
        history.push({ tool: call.name, input, screen: shown });
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `${message}\n\n${shown}` });
      }
    }

    messages.push({ role: 'user', content: results });
    saveTranscript();
    if (done) break;
  }

  recorder.event('run_finished', { status: rec.stopReason, turns: rec.turns, recordedActions: rec.actions.length });
  recorder.writeJson('recording.json', rec);
  return rec;
}

function toAction(tool: string, input: any): RecordedAction['action'] {
  switch (tool) {
    case 'navigate': return { kind: 'navigate', url: input.url };
    case 'click': return { kind: 'click' };
    case 'type_text': return { kind: 'type', value: { kind: 'const', value: input.text }, clearFirst: true };
    case 'select_option': return { kind: 'select', value: { kind: 'const', value: input.value } };
    case 'press_key': return { kind: 'press', key: input.key };
    case 'extract_output': return { kind: 'extract', extracts: [{ name: input.output_name, from: 'text', transform: input.transform ?? 'trim' }] };
    default: return { kind: 'assert' };
  }
}
