import 'dotenv/config';
import { runAgentTask, type Capability } from '../agent/invokeAgent.js';
import { parseArgs, str, loadArtifact, loadOverlay, baseUrlFor, resetFaults } from './common.js';
import { CapabilityArtifact } from '../schema/artifact.js';

/**
 * Drive the system the way the agent-facing product would: give an LLM a natural-language
 * task and a set of capabilities, and let it decide what to call. The model never sees the
 * portal — deterministic replay runs underneath every tool call.
 */
const args = parseArgs();
const task = str(args, 'task', 'What is the current savings balance for member 12345?');
const tenant = str(args, 'tenant', 'tenant-a');
const host = str(args, 'host', 'http://localhost:5173');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The agent decides which capability to call, so it needs a model; the capabilities it invokes do not.');
  process.exit(2);
}
process.env.PORTAL_USER ??= 'svc.agent';
process.env.PORTAL_PASS ??= 'demo';
await resetFaults(host);

const capabilities: Capability[] = ['member.read_savings_balance', 'member.open_sub_account']
  .map(id => {
    const artifact = CapabilityArtifact.parse(loadArtifact(`artifacts/${id}.json`));
    return { artifact, tenantId: tenant, baseUrl: baseUrlFor(tenant, host), overlay: loadOverlay(tenant, id) };
  });

console.log(`\nTASK: ${task}`);
console.log(`agent has ${capabilities.length} capabilities: ${capabilities.map(c => c.artifact.capability.id).join(', ')}\n`);

const out = await runAgentTask({
  task,
  capabilities,
  model: str(args, 'model', process.env.DISCOVERY_MODEL ?? 'claude-opus-5'),
  onToolCall: (cap, inputs) => console.log(`  → agent calls ${cap}(${JSON.stringify(inputs)})`),
});

for (const c of out.toolCalls) {
  const r = c.result;
  const line = r.status === 'success' ? `success ${JSON.stringify(r.outputs)}`
    : r.status === 'business_outcome' ? `business_outcome ${r.code}`
    : r.status === 'escalated' ? `escalated ${r.interventionId}` : `failure ${(r as any).kind}`;
  console.log(`  ← ${c.capability} returned: ${line}`);
}
console.log(`\nAGENT ANSWER (${out.turns} turns):\n  ${out.answer}\n`);
