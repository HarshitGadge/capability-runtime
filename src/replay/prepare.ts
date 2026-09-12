import type { CapabilityArtifact, TenantOverlay, BusinessOutcomeRule, RecoveryRule } from '../schema/artifact.js';
import type { ElementTarget } from '../schema/locator.js';
import type { Checkpoint } from '../schema/checkpoint.js';
import type { Step } from '../schema/step.js';

/**
 * Merge a tenant overlay onto a base capability.
 *
 * The merge is intentionally narrow: an overlay may retarget a control by `semanticId`
 * and may add recovery rules, and that is all. It cannot add, remove or reorder steps,
 * change the success condition, or widen the allowlist.
 *
 * That restriction is the multi-tenant design in one function. If overlays could change
 * the flow, then after a year you would have N per-tenant forks that nobody can review
 * or upgrade together, which is the outcome overlays exist to prevent. When a tenant
 * genuinely runs a *different* flow, that is a different capability version, recorded
 * and reviewed as such — not a quietly divergent overlay.
 */
export function applyOverlay(base: CapabilityArtifact, overlay?: TenantOverlay): CapabilityArtifact {
  if (!overlay) return base;
  if (overlay.capabilityId !== base.capability.id) {
    throw new Error(`Overlay is for capability ${overlay.capabilityId}, artifact is ${base.capability.id}`);
  }
  if (overlay.appliesToVersion !== base.capability.version) {
    // Loud, not fatal: a patch-version bump should not ground a tenant, but the
    // mismatch is exactly the drift signal a fleet operator needs to see.
    console.warn(`[overlay] ${overlay.tenantId}: written for ${overlay.appliesToVersion}, applying to ${base.capability.version}`);
  }

  const retarget = (t?: ElementTarget): ElementTarget | undefined => {
    if (!t) return t;
    const override = overlay.targetOverrides[t.semanticId];
    return override ? { ...t, ...override } : t;
  };

  const words = overlay.checkpointTextOverrides ?? {};
  const retext = (cp?: Checkpoint): Checkpoint | undefined => {
    if (!cp) return cp;
    return {
      ...cp,
      all: cp.all.map(a => {
        if ((a.kind !== 'text_present' && a.kind !== 'text_absent') || a.text.kind !== 'const') return a;
        const replacement = words[String(a.text.value)];
        return replacement ? { ...a, text: { kind: 'const' as const, value: replacement } } : a;
      }),
    };
  };
  const respec = (s: Step): Step => ({
    ...s,
    target: retarget(s.target),
    precondition: retext(s.precondition),
    postcondition: retext(s.postcondition),
  });

  return {
    ...base,
    steps: base.steps.map(respec),
    success: retext(base.success)!,
    businessOutcomes: base.businessOutcomes.map((b): BusinessOutcomeRule => ({ ...b, detect: retext(b.detect)! })),
    recoveries: [
      ...base.recoveries.map((r): RecoveryRule => ({ ...r, detect: retext(r.detect)!, actions: r.actions.map(respec) })),
      ...overlay.extraRecoveries,
    ],
  };
}

/** Contract enforcement at the boundary, before any UI is touched. */
export function validateInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, unknown>,
): { expected: string; observed: string } | null {
  for (const spec of artifact.inputs) {
    const value = inputs[spec.name];
    if (value == null || value === '') {
      if (spec.required) return { expected: `required input "${spec.name}" (${spec.type})`, observed: 'missing' };
      continue;
    }
    const s = String(value);
    if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(s)) {
      return { expected: `input "${spec.name}" to be a number`, observed: JSON.stringify(s) };
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(s)) {
      return { expected: `input "${spec.name}" to match /${spec.pattern}/`, observed: JSON.stringify(s) };
    }
  }
  const declared = new Set(artifact.inputs.map(i => i.name));
  const unknown = Object.keys(inputs).filter(k => !declared.has(k));
  if (unknown.length) return { expected: `only declared inputs [${[...declared].join(', ')}]`, observed: `unexpected: ${unknown.join(', ')}` };
  return null;
}
