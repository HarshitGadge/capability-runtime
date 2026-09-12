import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { discover } from '../agent/discover.js';
import { compile } from '../agent/compiler.js';
import { CapabilityArtifact } from '../schema/artifact.js';
import { stabilize } from '../replay/preflight.js';
import { parseArgs, str, flag, loadProfile, baseUrlFor, buildRuntime, resetFaults } from './common.js';

/**
 * Discovery run: an LLM drives the live surface until the goal is met, then the run is
 * compiled into a capability artifact.
 *
 * This is the only command that needs an API key. Everything downstream — replay,
 * recompilation, the whole production path — runs without one.
 */
const args = parseArgs();
const goal = str(args, 'goal', '');
if (!goal) {
  console.error('usage: npm run discover -- --goal "..." [--tenant tenant-a] [--provider dom-scan|cdp] [--headless]');
  process.exit(2);
}

const tenant = str(args, 'tenant', 'tenant-a');
const host = str(args, 'host', 'http://localhost:5173');
const model = str(args, 'model', process.env.DISCOVERY_MODEL ?? 'claude-opus-5');
const maxSteps = Number(str(args, 'max-steps', process.env.DISCOVERY_MAX_STEPS ?? '40'));
const profile = loadProfile(str(args, 'profile', 'profiles/portal.json'));
const baseUrl = baseUrlFor(tenant, host);

/**
 * A discovery run is a supervised activity — an engineer is watching it — so raising the
 * risk ceiling to record a flow that submits something irreversible is a reasonable
 * thing to allow. It is opt-in, per-run, and printed below, so it is an explicit and
 * logged decision rather than a default. Replay keeps the profile's ceiling and routes
 * those steps to a human.
 */
const allowRisk = str(args, 'allow-risk', profile.allowlist.maxUnattendedRisk) as 'safe' | 'elevated' | 'irreversible';
const allowlist = { ...profile.allowlist, maxUnattendedRisk: allowRisk };

process.env.PORTAL_USER ??= 'svc.agent';
process.env.PORTAL_PASS ??= 'demo';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Discovery needs a model; replay does not.');
  process.exit(2);
}

await resetFaults(host);

const rt = await buildRuntime({
  kind: 'discovery',
  allowlist,
  providerId: str(args, 'provider', 'dom-scan'),
  headless: flag(args, 'headless'),
});

console.log(`discovery run ${rt.runId}`);
console.log(`  goal      ${goal}`);
console.log(`  tenant    ${tenant} (${baseUrl})`);
console.log(`  model     ${model}`);
console.log(`  provider  ${rt.gate.providerId}`);
console.log(`  risk ceiling ${allowRisk}${allowRisk !== profile.allowlist.maxUnattendedRisk ? '  (raised for this supervised run; replay keeps ' + profile.allowlist.maxUnattendedRisk + ')' : ''}`);
console.log(`  evidence  ${rt.recorder.relDir()}\n`);

try {
  const recording = await discover({
    goal, entryPoint: `${baseUrl}/`, gate: rt.gate, recorder: rt.recorder, model, maxSteps,
    onEntry: async () => { await stabilize(rt.gate, profile.recoveries, { baseUrl }, rt.recorder); },
  });

  if (!recording.capability || !recording.actions.length) {
    console.error(`\nThe agent finished without recording a flow (${recording.turns} turns). Transcript: ${rt.recorder.relDir()}/transcript.json`);
    process.exit(1);
  }

  // The recording is already on disk at this point. If compilation fails — an unlocatable
  // control, or a literal the leak guard refuses — the run is not wasted: fix the compiler
  // and rebuild from the recording with no further API calls.
  let artifact;
  try {
    artifact = compile({
      capability: recording.capability,
      inputs: recording.inputs,
      outputs: recording.outputs,
      actions: recording.actions,
      successText: recording.successText,
      declaredOutcomes: recording.declaredOutcomes,
      profile: { ...profile, baseUrl },
      provenance: { discoveryModel: model, discoveryRunId: rt.runId, tenantId: tenant, evidenceDir: rt.recorder.relDir() },
    });
  } catch (err) {
    console.error(`\nThe run succeeded but compilation failed: ${err instanceof Error ? err.message : err}`);
    console.error(`The recording is saved. Rebuild from it with no API call once fixed:`);
    console.error(`  npm run compile -- --recording ${rt.recorder.relDir()}/recording.json`);
    process.exit(1);
  }

  const parsed = CapabilityArtifact.parse(artifact);
  const out = path.join('artifacts', `${parsed.capability.id}.json`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(parsed, null, 2));
  rt.recorder.writeJson('artifact.json', parsed, false);

  console.log(`\n✓ discovered "${parsed.capability.name}" in ${recording.turns} turns`);
  console.log(`  steps     ${parsed.steps.length}`);
  console.log(`  inputs    ${parsed.inputs.map(i => `${i.name}:${i.type}`).join(', ') || '(none)'}`);
  console.log(`  outputs   ${parsed.outputs.map(o => `${o.name}:${o.type}`).join(', ') || '(none)'}`);
  console.log(`  outcomes  ${parsed.businessOutcomes.map(b => b.code).join(', ') || '(none)'}`);
  console.log(`  artifact  ${out}`);
  console.log(`\nreplay it:\n  npm run replay -- --artifact ${out} ${parsed.inputs.map(i => `--input ${i.name}=${i.example}`).join(' ')}`);
} finally {
  rt.recorder.close();
  await rt.gate.close();
  await rt.browser.close().catch(() => {});
}
