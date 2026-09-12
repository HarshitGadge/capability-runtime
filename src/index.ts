import type Anthropic from '@anthropic-ai/sdk';
import { CapabilityArtifact, TenantOverlay } from './schema/artifact.js';
import type { ReplayResult } from './schema/result.js';
import { ReplayEngine } from './replay/engine.js';
import { claimForAutomation } from './escalation/lease.js';
import type { Escalator } from './escalation/escalator.js';
import { buildRuntime } from './cli/common.js';

export type { CapabilityArtifact, TenantOverlay, ReplayResult };
export { CapabilityArtifact as CapabilityArtifactSchema, TenantOverlay as TenantOverlaySchema } from './schema/artifact.js';
export { ReplayResult as ReplayResultSchema } from './schema/result.js';

/**
 * The programmatic face of a capability — what an agent's tool-call handler uses.
 *
 * `toolDefinition()` is what the agent is shown: the capability rendered as a tool, with
 * its declared inputs as the parameter schema and its outputs and business-outcome codes
 * in the description. `invoke()` is what runs when the agent calls that tool. The
 * `ReplayResult` union is what comes back, and its four arms are the contract the agent
 * branches on: an answer, a legitimate non-answer, a failure worth debugging, or a
 * handoff to a person. No model is consulted anywhere in between.
 */

export function toolDefinition(artifact: CapabilityArtifact): Anthropic.Tool {
  const a = artifact;
  return {
    name: a.capability.id.replace(/\./g, '_'),
    description: [
      a.capability.description,
      `Returns: ${a.outputs.map(o => `${o.name} (${o.type}) — ${o.description.replace(/\.$/, '')}`).join('; ') || 'no outputs'}.`,
      a.businessOutcomes.length
        ? `May instead return one of these business outcomes, which are results and not errors: ${a.businessOutcomes.map(b => `${b.code} (${b.description})`).join('; ')}.`
        : '',
      `Executes deterministically against ${a.target.appId} with no model in the loop.`,
    ].filter(Boolean).join(' '),
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(a.inputs.map(i => [i.name, {
        type: i.type === 'number' ? 'number' : 'string',
        description: i.description,
        ...(i.pattern ? { pattern: i.pattern } : {}),
      }])),
      required: a.inputs.filter(i => i.required).map(i => i.name),
      additionalProperties: false,
    },
  };
}

export interface InvokeOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, unknown>;
  tenantId: string;
  /** The tenant's base URL. Its origin becomes the run's allowlisted origin. */
  baseUrl: string;
  overlay?: TenantOverlay;
  headless?: boolean;
  providerId?: string;
  /** Without one, steps that need a human fail closed instead of waiting. */
  escalator?: Escalator;
}

/**
 * Run a capability. Attaches to the shared browser session if one is up (so a human can
 * take over mid-run), otherwise launches a private one; either way the browser is
 * released when the run ends, whatever the outcome.
 */
export async function invoke(opts: InvokeOptions): Promise<ReplayResult> {
  const artifact = CapabilityArtifact.parse(opts.artifact);
  const overlay = opts.overlay ? TenantOverlay.parse(opts.overlay) : undefined;
  if (overlay && new URL(overlay.baseUrl).origin !== new URL(opts.baseUrl).origin) {
    throw new Error(`Overlay for ${overlay.tenantId} binds origin ${new URL(overlay.baseUrl).origin}, but baseUrl is ${opts.baseUrl}`);
  }

  const rt = await buildRuntime({
    kind: 'replay',
    allowlist: { ...artifact.target.allowlist, origins: [new URL(opts.baseUrl).origin] },
    providerId: opts.providerId ?? 'dom-scan',
    headless: opts.headless ?? true,
  });
  claimForAutomation();

  try {
    const result = await new ReplayEngine({
      artifact, overlay, baseUrl: opts.baseUrl, tenantId: opts.tenantId, inputs: opts.inputs,
      gate: rt.gate, recorder: rt.recorder, escalator: opts.escalator,
    }).run();
    rt.recorder.writeJson('result.json', result, false);
    return result;
  } finally {
    rt.recorder.close();
    await rt.gate.close();
    await rt.browser.close().catch(() => {});
  }
}
