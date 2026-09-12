import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { discover } from '../agent/discover.js';
import { compile } from '../agent/compiler.js';
import { CapabilityArtifact } from '../schema/artifact.js';
import { stabilize } from '../replay/preflight.js';
import { scrubDeclaredValues, collectValuesByLabel } from '../evidence/scrub.js';
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
  console.error('usage: npm run discover -- --goal "..." [--tenant tenant-a] [--entry <url>] [--max-steps N] [--timeout-ms N] [--provider dom-scan|cdp] [--allow-risk safe|elevated|irreversible] [--headless]');
  process.exit(2);
}

const tenant = str(args, 'tenant', 'tenant-a');
const host = str(args, 'host', 'http://localhost:5173');
const model = str(args, 'model', process.env.DISCOVERY_MODEL ?? 'claude-opus-5');
const maxSteps = Number(str(args, 'max-steps', process.env.DISCOVERY_MAX_STEPS ?? '40'));
const timeoutMs = Number(str(args, 'timeout-ms', process.env.DISCOVERY_TIMEOUT_MS ?? String(10 * 60_000)));
const profile = loadProfile(str(args, 'profile', 'profiles/portal.json'));
const baseUrl = baseUrlFor(tenant, host);
// The target is goal + entry point. The entry point defaults to the tenant's root but can
// be any allowlisted URL, so a capability can be discovered from deep inside an app.
const entryPoint = str(args, 'entry', `${baseUrl}/`);

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
console.log(`  entry     ${entryPoint}`);
console.log(`  budget    ${maxSteps} turns / ${Math.round(timeoutMs / 1000)}s`);
console.log(`  model     ${model}`);
console.log(`  provider  ${rt.gate.providerId}`);
console.log(`  risk ceiling ${allowRisk}${allowRisk !== profile.allowlist.maxUnattendedRisk ? '  (raised for this supervised run; replay keeps ' + profile.allowlist.maxUnattendedRisk + ')' : ''}`);
console.log(`  evidence  ${rt.recorder.relDir()}\n`);

try {
  const recording = await discover({
    goal, entryPoint, gate: rt.gate, recorder: rt.recorder, model, maxSteps, timeoutMs,
    onEntry: async () => { await stabilize(rt.gate, profile.recoveries, { baseUrl }, rt.recorder); },
  });

  // A run that stopped for any reason other than reaching the goal is not a capability,
  // whatever it recorded on the way. Say why it stopped, keep the transcript, exit non-zero.
  if (recording.stopReason !== 'goal_reached') {
    console.error(`\nDiscovery stopped: ${recording.stopReason} after ${recording.turns} turns. Transcript: ${rt.recorder.relDir()}/transcript.json`);
    process.exit(recording.stopReason === 'model_declined' ? 5 : 1);
  }
  if (!recording.capability || !recording.actions.length) {
    console.error(`\nThe agent reported success without recording a flow (${recording.turns} turns). Transcript: ${rt.recorder.relDir()}/transcript.json`);
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

  // Now that the artifact declares which outputs are regulated, scrub their extracted
  // values from this run's evidence — the transcript included. Input examples are kept:
  // they are the caller's parameter, and the recording needs them to parameterize.
  const withheld = new Set(parsed.outputs.filter(o => o.sensitivity === 'regulated' || o.sensitivity === 'secret').map(o => o.name));
  const values = recording.actions.flatMap(a =>
    a.action.kind === 'extract' && a.element
      ? a.action.extracts.filter(x => withheld.has(x.name)).map(x => ({ name: x.name, value: (a.element!.text ?? a.element!.name ?? '').trim() }))
      : []);
  const labels = parsed.steps.flatMap(s => s.action.kind === 'extract' && s.target
    ? s.action.extracts.filter(x => withheld.has(x.name)).flatMap(x =>
        s.target!.strategies.filter(st => st.kind === 'proximity_label').map(st => ({ name: x.name, label: (st as { label: string }).label })))
    : []);
  // Never scrub structure. Labels and screen headings are how the artifact finds things
  // and proves where it is; a scrub that tokenized "Status" because a value happened to
  // read "Status" would leave a recording that no longer recompiles to this artifact.
  const structural = new Set<string>([
    ...parsed.inputs.map(i => String(i.example ?? '')),
    ...parsed.steps.flatMap(s => (s.target?.strategies ?? []).flatMap(st => 'label' in st ? [st.label] : 'name' in st ? [st.name] : 'text' in st ? [st.text] : [])),
    ...[parsed.success, ...parsed.steps.flatMap(s => [s.precondition, s.postcondition])]
      .flatMap(cp => cp?.all ?? []).flatMap(a => a.kind === 'text_present' && a.text.kind === 'const' ? [String(a.text.value)] : []),
  ]);
  const scrubbed = scrubDeclaredValues(rt.recorder.dir, [...values, ...collectValuesByLabel(rt.recorder.dir, labels)], [...structural]);
  console.log(`  scrubbed  ${values.length} regulated output value(s) from ${scrubbed.files.length} evidence file(s)`);
  const out = path.join('artifacts', `${parsed.capability.id}.json`);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(parsed, null, 2));
  rt.recorder.writeJson('artifact.json', parsed, false);

  console.log(`\n✓ discovered "${parsed.capability.name}" in ${recording.turns} turns (${recording.stopReason})`);
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
