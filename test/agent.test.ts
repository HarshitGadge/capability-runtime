import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { runAgentTask, type Capability } from '../src/agent/invokeAgent.js';
import { toolDefinition } from '../src/index.js';
import { CapabilityArtifact } from '../src/schema/artifact.js';
import type { ReplayResult } from '../src/schema/result.js';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * The agent-integration seam, tested without a model or a browser: a scripted client
 * emits tool_use blocks, a stub invoke returns typed results, and we assert the loop
 * routes calls to the right capability and hands each result back in a form the agent
 * can branch on. The real `npm run agent` uses the same code path with a live model and
 * real replay underneath.
 */
const artifact = CapabilityArtifact.parse(JSON.parse(fs.readFileSync('artifacts/member.read_savings_balance.json', 'utf8')));
const cap: Capability = { artifact, tenantId: 'tenant-a', baseUrl: 'http://localhost:5173/t/tenant-a' };
const toolName = toolDefinition(artifact).name;

/** A fake model: first turn calls the tool, second turn answers from the tool result. */
function scriptedClient(toolInput: Record<string, unknown>): { messages: { create: (...a: any[]) => Promise<any> } } {
  let turn = 0;
  return {
    messages: {
      create: async ({ messages }: { messages: Anthropic.MessageParam[] }) => {
        turn++;
        if (turn === 1) {
          return { content: [{ type: 'tool_use', id: 't1', name: toolName, input: toolInput }], stop_reason: 'tool_use' };
        }
        // Echo whatever the tool returned so the test can assert the agent saw it.
        const last = messages[messages.length - 1]!;
        const toolResult = (last.content as any[]).find(b => b.type === 'tool_result');
        return { content: [{ type: 'text', text: `done: ${toolResult.content}` }], stop_reason: 'end_turn' };
      },
    },
  };
}

const stubInvoke = (result: ReplayResult) => async () => result;
const base = { runId: 'r', tenantId: 'tenant-a', startedAt: '', durationMs: 1, evidenceDir: '', trace: [], capabilityId: artifact.capability.id, capabilityVersion: '1.0.0', surfaceDrift: { recorded: '', observed: '', comparedSteps: 0, totalSteps: 0, drifted: null, changedSteps: [] } };

describe('agent invoking a capability as a tool', () => {
  it('exposes the capability with its business outcomes in the tool description', () => {
    const tool = toolDefinition(artifact);
    expect(tool.input_schema.properties).toHaveProperty('member_id');
    expect(tool.description).toContain('MEMBER_NOT_FOUND');
    expect(tool.description).toMatch(/results and not errors/);
  });

  it('routes a tool call to invoke and returns the outputs to the agent', async () => {
    const out = await runAgentTask({
      task: 'balance for 12345?',
      capabilities: [cap],
      client: scriptedClient({ member_id: '12345' }),
      invokeFn: stubInvoke({ status: 'success', ...base, outputs: { savings_balance: 18204.37 } }),
    });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.inputs).toEqual({ member_id: '12345' });
    expect(out.answer).toContain('18204.37');
  });

  it('hands a business outcome back as a result, flagged as not-an-error', async () => {
    const out = await runAgentTask({
      task: 'is 99999 a member?',
      capabilities: [cap],
      client: scriptedClient({ member_id: '99999' }),
      invokeFn: stubInvoke({ status: 'business_outcome', ...base, code: 'MEMBER_NOT_FOUND', message: 'No such member.', atStepId: 's', outputs: {} }),
    });
    expect(out.toolCalls[0]!.result.status).toBe('business_outcome');
    expect(out.answer).toContain('MEMBER_NOT_FOUND');
    expect(out.answer).toMatch(/not an error/);
  });

  it('surfaces an escalation as paused, not done', async () => {
    const out = await runAgentTask({
      task: 'open a sub-account',
      capabilities: [cap],
      client: scriptedClient({ member_id: '12345' }),
      invokeFn: stubInvoke({ status: 'escalated', ...base, interventionId: 'INT-1', reason: 'irreversible', atStepId: 's', resumable: true, resumeToken: 'x' }),
    });
    expect(out.answer).toContain('INT-1');
    expect(out.answer).toMatch(/paused, not done/);
  });
});
