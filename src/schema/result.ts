import { z } from 'zod';

/**
 * Why a replay stopped. The four arms are the contract 3.3 asks for, and the split is
 * the point: a caller must be able to tell "the app told us there is no such member"
 * from "we could not find the search button" without parsing strings.
 */

export const StepTrace = z.object({
  stepId: z.string(),
  intent: z.string(),
  status: z.enum(['ok', 'recovered', 'skipped', 'failed']),
  /** Which rung of the locator cascade actually matched. Silent degradation made visible. */
  locatorStrategyUsed: z.string().optional(),
  locatorCandidates: z.number().int().optional(),
  attempts: z.number().int(),
  durationMs: z.number(),
  recoveriesApplied: z.array(z.string()).default([]),
});
export type StepTrace = z.infer<typeof StepTrace>;

export const FailureKind = z.enum([
  'precondition_unmet',
  'postcondition_unmet',
  'locator_not_found',
  'locator_ambiguous',
  'timeout',
  'policy_denied',
  'invalid_input',
  'surface_error',
  'success_condition_unmet',
  'missing_required_output',
  'recovery_exhausted',
  'attempts_exhausted',
]);
export type FailureKind = z.infer<typeof FailureKind>;

/**
 * Did the surface still look the way it did when the capability was recorded?
 *
 * Compares the structural fingerprint stamped into the artifact's provenance against
 * the same fingerprint computed from the screens this run actually observed. It is
 * only assessable when every step's screen was seen, so a run that stopped early
 * reports `drifted: null` rather than a guess. Drift is a signal, never a failure: the
 * run's own checkpoints decide whether it worked; this says whether to re-review it.
 */
export const SurfaceDrift = z.object({
  recorded: z.string(),
  observed: z.string(),
  comparedSteps: z.number().int(),
  totalSteps: z.number().int(),
  drifted: z.boolean().nullable(),
  /** Which steps' screens changed shape, when the artifact recorded per-step shapes. */
  changedSteps: z.array(z.object({ stepId: z.string(), recorded: z.string(), observed: z.string() })).default([]),
});
export type SurfaceDrift = z.infer<typeof SurfaceDrift>;

const Base = {
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  runId: z.string(),
  tenantId: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  evidenceDir: z.string(),
  trace: z.array(StepTrace),
  surfaceDrift: SurfaceDrift,
};

export const ReplayResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    ...Base,
    /** Keyed by declared output name. Regulated values are in the clear here and redacted on disk. */
    outputs: z.record(z.string(), z.unknown()),
  }),

  /**
   * The app answered, and the answer is a legitimate business result. Not an error.
   * The caller is expected to branch on `code`.
   */
  z.object({
    status: z.literal('business_outcome'),
    ...Base,
    code: z.string(),
    message: z.string(),
    atStepId: z.string(),
    outputs: z.record(z.string(), z.unknown()).default({}),
  }),

  /** Something is wrong with the automation or the surface. Debuggable, not expected. */
  z.object({
    status: z.literal('failure'),
    ...Base,
    kind: FailureKind,
    atStepId: z.string().optional(),
    /** Both sides of the comparison, so a reader does not need the screenshots to start. */
    expected: z.string(),
    observed: z.string(),
    /** Richer signal captured at the moment of failure. */
    screenshotPath: z.string().optional(),
    observationPath: z.string().optional(),
    remediation: z.string().optional().describe('What a human should check first.'),
  }),

  /**
   * Handed to a human. The run is suspended, not over: the session is still live and
   * `resumeToken` lets the runner pick the flow back up at `atStepId`.
   */
  z.object({
    status: z.literal('escalated'),
    ...Base,
    interventionId: z.string(),
    reason: z.string(),
    atStepId: z.string(),
    resumable: z.boolean(),
    resumeToken: z.string(),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResult>;
