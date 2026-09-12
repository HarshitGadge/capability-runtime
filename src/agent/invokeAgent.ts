import Anthropic from '@anthropic-ai/sdk';
import type { CapabilityArtifact, TenantOverlay } from '../schema/artifact.js';
import type { ReplayResult } from '../schema/result.js';
import { toolDefinition, invoke, type InvokeOptions } from '../index.js';

/**
 * The production shape, made concrete: an AI agent with a goal, a set of capabilities it
 * may call, and no knowledge of any UI.
 *
 * This is the through-line the whole system exists for. The agent is shown each
 * capability as a tool (name, typed parameters, and — crucially — its declared business
 * outcomes), decides which to call and with what inputs, and receives a typed
 * `ReplayResult` back. Deterministic replay is what runs underneath the tool call; the
 * model here never sees the portal, never reasons about a locator, and never spends a
 * token on the UI. It reasons only about the task and the result.
 *
 * The agent loop and the capability are cleanly separated: `runAgentTask` is provider
 * code that could sit in the agent-facing product, and everything it touches from this
 * package is the two exported functions `toolDefinition` and `invoke`.
 */

export interface Capability {
  artifact: CapabilityArtifact;
  tenantId: string;
  baseUrl: string;
  overlay?: TenantOverlay;
}

export interface AgentTaskResult {
  answer: string;
  toolCalls: Array<{ capability: string; inputs: Record<string, unknown>; result: ReplayResult }>;
  turns: number;
}

/**
 * The slice of the client the loop uses, structural so a scripted fake can stand in for
 * tests. The real `Anthropic` client satisfies it; a test double returning a plain
 * promise of the same shape does too.
 */
export interface AgentModel {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * How a tool result is presented back to the agent.
 *
 * The agent must be able to act on the four arms of the contract without parsing prose,
 * so the result is handed back as compact JSON: an answer with outputs, a named business
 * outcome it should report rather than treat as an error, a failure it should surface, or
 * an escalation that a person now holds. Regulated outputs are already redacted in the
 * replay's evidence, but the values returned here are what the caller asked for — this is
 * the in-process boundary where the real answer legitimately lives.
 */
function toolResultFor(result: ReplayResult): string {
  switch (result.status) {
    case 'success':
      return JSON.stringify({ status: 'success', outputs: result.outputs });
    case 'business_outcome':
      return JSON.stringify({ status: 'business_outcome', code: result.code, message: result.message, note: 'This is a legitimate result, not an error. Report it to the user plainly.' });
    case 'failure':
      return JSON.stringify({ status: 'failure', kind: result.kind, detail: result.observed, note: 'The automation could not complete. Do not retry blindly; report that it failed.' });
    case 'escalated':
      return JSON.stringify({ status: 'escalated', interventionId: result.interventionId, note: 'A human operator has been asked to complete a step. The task is paused, not done.' });
  }
}

export async function runAgentTask(opts: {
  task: string;
  capabilities: Capability[];
  model?: string;
  client?: AgentModel;
  maxTurns?: number;
  invokeFn?: (o: InvokeOptions) => Promise<ReplayResult>;
  onToolCall?: (capability: string, inputs: Record<string, unknown>) => void;
}): Promise<AgentTaskResult> {
  const client = opts.client ?? new Anthropic();
  const runInvoke = opts.invokeFn ?? invoke;
  const maxTurns = opts.maxTurns ?? 6;

  // Each capability becomes a tool; the map lets the loop route a call back to the
  // right artifact, tenant and base URL when the agent picks one by name.
  const tools = opts.capabilities.map(c => toolDefinition(c.artifact));
  const byToolName = new Map(opts.capabilities.map(c => [toolDefinition(c.artifact).name, c]));

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.task }];
  const toolCalls: AgentTaskResult['toolCalls'] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: opts.model ?? 'claude-opus-5',
      max_tokens: 2000,
      system:
        'You are a back-office assistant for a credit union. You accomplish tasks by calling the ' +
        'capabilities you are given — you never see or reason about any user interface. When a capability ' +
        'returns a business_outcome, that is a real answer (for example, no such member), not a failure: ' +
        'report it plainly. When it returns a failure or escalation, say so honestly rather than guessing.',
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!calls.length) {
      const answer = response.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join(' ').trim();
      return { answer, toolCalls, turns: turn + 1 };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const cap = byToolName.get(call.name);
      if (!cap) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No such capability: ${call.name}` });
        continue;
      }
      const inputs = call.input as Record<string, unknown>;
      opts.onToolCall?.(call.name, inputs);
      const result = await runInvoke({
        artifact: cap.artifact, inputs, tenantId: cap.tenantId, baseUrl: cap.baseUrl, overlay: cap.overlay,
      });
      toolCalls.push({ capability: call.name, inputs, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: toolResultFor(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { answer: '(agent did not conclude within the turn budget)', toolCalls, turns: maxTurns };
}
