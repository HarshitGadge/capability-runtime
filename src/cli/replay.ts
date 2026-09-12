import 'dotenv/config';
import { ReplayEngine } from '../replay/engine.js';
import { Escalator } from '../escalation/escalator.js';
import { watchHumanActions } from '../escalation/humanWatch.js';
import { claimForAutomation } from '../escalation/lease.js';
import { sessionIsShared } from '../escalation/session.js';
import { CapabilityArtifact } from '../schema/artifact.js';
import {
  parseArgs, str, flag, inputPairs, loadArtifact, loadOverlay, baseUrlFor,
  buildRuntime, injectFault, resetFaults, printResultSummary,
} from './common.js';

/**
 * The production execution path: replay a capability with no model in the loop.
 */
const args = parseArgs();
const artifactPath = str(args, 'artifact', '');
if (!artifactPath) {
  console.error('usage: npm run replay -- --artifact artifacts/<id>.json --input k=v [--tenant tenant-a] [--inject session_timeout|interstitial|slow] [--provider dom-scan|cdp] [--headless]');
  process.exit(2);
}

const artifact = CapabilityArtifact.parse(loadArtifact(artifactPath));
const tenant = str(args, 'tenant', 'tenant-a');
const host = str(args, 'host', 'http://localhost:5173');
const baseUrl = baseUrlFor(tenant, host);
const inputs = inputPairs(args);
// --no-overlay forces the unspecialized capability against a tenant, which is how the
// drift story is demonstrated rather than asserted.
const overlay = flag(args, 'no-overlay')
  ? undefined
  : loadOverlay(tenant, artifact.capability.id, typeof args.overlay === 'string' ? args.overlay : undefined);

// Service credentials are injected from the environment at run time and never live in
// the artifact. The defaults here are the stand-in portal's throwaway demo values.
process.env.PORTAL_USER ??= 'svc.agent';
process.env.PORTAL_PASS ??= 'demo';

await resetFaults(host);
await injectFault(host, str(args, 'inject', 'none'), Number(str(args, 'inject-count', '1')), str(args, 'inject-on', '/member'));

const rt = await buildRuntime({
  kind: 'replay',
  allowlist: { ...artifact.target.allowlist, origins: [new URL(baseUrl).origin] },
  providerId: str(args, 'provider', 'dom-scan'),
  headless: flag(args, 'headless'),
});
claimForAutomation();

console.log(`replay ${rt.runId}: ${artifact.capability.id}@${artifact.capability.version}`);
console.log(`  tenant    ${tenant}${overlay ? ` (overlay: ${Object.keys(overlay.targetOverrides).length} target override(s))` : ' (no overlay)'}`);
console.log(`  inputs    ${JSON.stringify(inputs)}`);
console.log(`  provider  ${rt.gate.providerId}`);
console.log(`  session   ${sessionIsShared() ? 'shared (human handoff available)' : 'private (auto-launched; not handoff-capable)'}`);

const escalator = new Escalator({
  recorder: rt.recorder,
  redactor: rt.redactor,
  waitMs: Number(str(args, 'escalation-wait', sessionIsShared() ? '180000' : '0')),
  screenshot: () => rt.surface.screenshot(),
  watchHumanActions: cb => watchHumanActions(rt.page, cb),
});

try {
  const engine = new ReplayEngine({
    artifact, overlay, baseUrl, tenantId: tenant, inputs,
    gate: rt.gate, recorder: rt.recorder, escalator,
    startAtStepId: typeof args['resume-at'] === 'string' ? (args['resume-at'] as string) : undefined,
  });

  const result = await engine.run();
  rt.recorder.writeJson('result.json', result, false);
  printResultSummary(result);

  // Exit codes let a caller branch without parsing stdout: 0 success, 3 a legitimate
  // business outcome, 4 escalated, 1 a genuine failure.
  process.exitCode = result.status === 'success' ? 0 : result.status === 'business_outcome' ? 3 : result.status === 'escalated' ? 4 : 1;
} finally {
  rt.recorder.close();
  await rt.gate.close();
  await rt.browser.close().catch(() => {});
  await resetFaults(host);
}
