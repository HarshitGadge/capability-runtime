import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import type { PolicyGate } from '../policy/gate.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Observation, UiElement } from '../schema/observation.js';
import type { ParamSpec, OutputSpec } from '../schema/artifact.js';
import { renderObservation } from './render.js';
import { TOOLS, SYSTEM_PROMPT } from './tools.js';
import type { RecordedAction } from './compiler.js';

export interface DiscoveryOptions {
  goal: string;
  entryPoint: string;
  gate: PolicyGate;
  recorder: EvidenceRecorder;
  model: string;
  maxSteps: number;
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
  const client = new Anthropic();

  const rec: DiscoveryRecording = {
    goal, model: opts.model, capability: null, inputs: [], outputs: [],
    actions: [], declaredOutcomes: [], successText: '', summary: '', turns: 0,
  };

  let phase: 'explore' | 'record' = 'explore';
  let index = new Map<string, UiElement>();

  await gate.withContext({ risk: 'safe', stepId: 'entry', intent: 'Open the application entry point' }).navigate(entryPoint);
  await opts.onEntry?.();

  const screen = async (): Promise<string> => {
    const obs = await gate.observeForModel();
    const rendered = renderObservation(obs);
    index = rendered.index;
    return rendered.text;
  };

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `GOAL: ${goal}\n\nEntry point: ${entryPoint}\n\nCurrent screen:\n\n${await screen()}` },
  ];

  const transcriptPath = `${recorder.dir}/transcript.json`;
  const saveTranscript = () => fs.writeFileSync(transcriptPath, JSON.stringify(messages, null, 2));

  for (let turn = 0; turn < opts.maxSteps; turn++) {
    rec.turns = turn + 1;

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
      throw new Error(`Model declined the task: ${JSON.stringify(response.stop_details)}`);
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
          rec.summary = input.summary;
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
        const rendered = renderObservation(await gate.observeForModel());
        index = rendered.index;
        results.push({ type: 'tool_result', tool_use_id: call.id, content: rendered.text });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recorder.event('note', { message: `tool ${call.name} failed: ${message}` });
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `${message}\n\n${await screen()}` });
      }
    }

    messages.push({ role: 'user', content: results });
    saveTranscript();
    if (done) break;
  }

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
