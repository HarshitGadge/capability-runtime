import { z } from 'zod';
import { Checkpoint } from './checkpoint.js';
import { Step } from './step.js';
import { ElementTarget } from './locator.js';

export const SCHEMA_VERSION = '1.0.0' as const;

/**
 * Sensitivity drives redaction, not access control. `regulated` values are tokenized
 * before they ever reach the model, the logs, or the artifact; they are returned to
 * the in-process caller in the clear and nowhere else.
 */
export const Sensitivity = z.enum(['public', 'internal', 'regulated', 'secret']);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const ParamType = z.enum(['string', 'number', 'boolean', 'currency', 'date']);

export const ParamSpec = z.object({
  name: z.string(),
  type: ParamType,
  required: z.boolean().default(true),
  description: z.string(),
  sensitivity: Sensitivity.default('internal'),
  /** Rejected before the browser is touched, so bad input never becomes a UI error. */
  pattern: z.string().optional().describe('RegExp source the supplied value must match.'),
  example: z.string().optional(),
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  name: z.string(),
  type: ParamType,
  description: z.string(),
  sensitivity: Sensitivity.default('regulated'),
  required: z.boolean().default(true).describe('If true, absence at the end of a successful run is a failure, not a partial success.'),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

/**
 * A named, expected, non-error end state.
 *
 * This is the schema's load-bearing idea for error handling. "No such member" is not a
 * crash and not a success — it is information the caller asked for. Declaring these in
 * the artifact means the replay engine recognizes them by evidence on the screen rather
 * than by a thrown exception, and the caller gets a typed code instead of a stack trace.
 */
export const BusinessOutcomeRule = z.object({
  code: z.string().describe('Stable machine code, e.g. MEMBER_NOT_FOUND.'),
  description: z.string(),
  detect: Checkpoint,
  /** Outcomes are terminal by definition; the field is explicit so reviewers see it. */
  terminal: z.literal(true).default(true),
  /** Outputs the caller can still expect. Usually empty. */
  partialOutputs: z.array(z.string()).default([]),
});
export type BusinessOutcomeRule = z.infer<typeof BusinessOutcomeRule>;

/**
 * A condition replay is allowed to fix by itself. Each one is a *named, anticipated*
 * interruption with a bounded budget — never a blanket retry.
 */
export const RecoveryRule = z.object({
  code: z.string().describe('e.g. MAINTENANCE_INTERSTITIAL, SESSION_EXPIRED.'),
  description: z.string(),
  detect: Checkpoint,
  /** Remediation steps, run with the same policy gate as any other step. */
  actions: z.array(Step).min(1),
  maxAttempts: z.number().int().positive().default(2),
  /** What to do once remediation succeeds. */
  then: z.enum(['retry_step', 'continue', 'restart_flow']).default('retry_step'),
  /** If remediation is exhausted, escalate to a human instead of failing outright. */
  escalateOnExhaustion: z.boolean().default(false),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

export const Allowlist = z.object({
  /** Exact origins the surface may occupy. Navigation outside is denied, not warned. */
  origins: z.array(z.string()).min(1),
  /** Path prefixes within those origins. `["/"]` permits the whole origin. */
  pathPrefixes: z.array(z.string()).default(['/']),
  /** Action verbs permitted at all for this capability. */
  actions: z.array(z.enum(['navigate', 'click', 'type', 'press', 'select', 'extract', 'assert'])),
  /** Highest risk class the runtime may execute unattended. Anything above routes to a human. */
  maxUnattendedRisk: z.enum(['safe', 'elevated', 'irreversible']).default('elevated'),
});
export type Allowlist = z.infer<typeof Allowlist>;

export const Provenance = z.object({
  recordedAt: z.string(),
  /** Which model discovered the flow, for auditing a capability's origin. */
  discoveryModel: z.string(),
  discoveryRunId: z.string(),
  /** Tenant the recording was made against — a fact about provenance, not a constraint on reuse. */
  recordedAgainstTenant: z.string(),
  evidenceDir: z.string(),
  /** Fingerprint of the recorded surface; replay warns when the live surface has drifted. */
  surfaceFingerprint: z.string(),
  notes: z.string().optional(),
});

/**
 * The capability artifact: a typed, versioned, reviewable description of one flow.
 *
 * It is deliberately *not* a transcript. The model's reasoning, its false starts and
 * its prose are evidence, kept in /evidence; what survives into the artifact is the
 * flow that worked, with targeting computed by the runtime from the elements actually
 * interacted with. That separation is what makes the artifact reviewable by a human
 * and callable by another agent.
 */
export const CapabilityArtifact = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),

  capability: z.object({
    id: z.string().describe('Stable slug, e.g. member.read_savings_balance.'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string(),
    /** The tool description a calling agent reads when deciding whether to invoke this. */
    description: z.string(),
    tags: z.array(z.string()).default([]),
  }),

  target: z.object({
    appId: z.string().describe('The vendor product, not the tenant. Artifacts are keyed to products.'),
    appVersion: z.string(),
    surface: z.enum(['web', 'desktop', 'terminal']),
    entryPoint: z.string().describe('URL template; {baseUrl} is supplied per tenant at replay time.'),
    allowlist: Allowlist,
  }),

  inputs: z.array(ParamSpec).default([]),
  outputs: z.array(OutputSpec).default([]),

  steps: z.array(Step).min(1),

  /** The one condition that decides whether the capability achieved its goal. */
  success: Checkpoint,

  businessOutcomes: z.array(BusinessOutcomeRule).default([]),
  recoveries: z.array(RecoveryRule).default([]),

  provenance: Provenance,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

/**
 * Per-tenant specialization, stored beside the artifact and never inside it.
 *
 * Keeping overlays as separate documents is the whole multi-tenant answer: the
 * capability is authored once against a vendor product, and a tenant whose skin breaks
 * one locator ships a few lines of override instead of re-recording the flow. An
 * overlay can retarget a control or supply tenant config, but it cannot add, remove or
 * reorder steps — that restriction is what stops overlays from silently forking the
 * capability into N divergent flows nobody can review.
 */
export const TenantOverlay = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  tenantId: z.string(),
  capabilityId: z.string(),
  /** Overlay is valid only for artifacts whose version satisfies this. */
  appliesToVersion: z.string(),
  baseUrl: z.string(),
  /** semanticId -> replacement target. Merged over the base target of the same id. */
  targetOverrides: z.record(z.string(), ElementTarget.partial().required({ strategies: true })).default({}),
  /**
   * Literal -> tenant's equivalent, applied to every text assertion in the capability.
   *
   * Screens are identified by the words on them, and tenants rename things: one calls a
   * screen "Member Lookup", another "Find a Member". Without this, a capability recorded
   * against one institution asserts another institution's wording and fails on a screen
   * that is functionally identical. The mapping is declarative and reviewable, and it
   * still cannot change which screens the flow visits or in what order.
   */
  checkpointTextOverrides: z.record(z.string(), z.string()).default({}),
  /** Additional tenant-specific interstitials (a tenant-only MOTD banner, say). */
  extraRecoveries: z.array(RecoveryRule).default([]),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;
