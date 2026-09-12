import fs from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CapabilityArtifact, TenantOverlay } from '../schema/artifact.js';
import { ReplayResult } from '../schema/result.js';
import { parseArgs, str, loadArtifact } from './common.js';
import { toolDefinition } from '../index.js';

/**
 * Emit the machine-readable contracts.
 *
 * Two audiences. A human reviewing a capability gets the artifact JSON Schema. A calling
 * agent gets `--tool <artifact>`: the capability rendered as a tool definition, with the
 * declared inputs as its parameter schema and the declared outputs and business outcome
 * codes in its description. That is the payoff of typing the contract — a recorded flow
 * becomes something another agent can be handed without a human writing an adapter.
 */
const args = parseArgs();
fs.mkdirSync('artifacts/schema', { recursive: true });

const toolFor = str(args, 'tool', '');
if (toolFor) {
  console.log(JSON.stringify(toolDefinition(loadArtifact(toolFor)), null, 2));
} else {
  const write = (name: string, schema: unknown) => {
    const p = `artifacts/schema/${name}.schema.json`;
    fs.writeFileSync(p, JSON.stringify(schema, null, 2));
    console.log(`wrote ${p}`);
  };
  write('capability-artifact', zodToJsonSchema(CapabilityArtifact, 'CapabilityArtifact'));
  write('tenant-overlay', zodToJsonSchema(TenantOverlay, 'TenantOverlay'));
  write('replay-result', zodToJsonSchema(ReplayResult, 'ReplayResult'));
}
