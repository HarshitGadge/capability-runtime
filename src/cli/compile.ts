import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../agent/compiler.js';
import { CapabilityArtifact } from '../schema/artifact.js';
import { parseArgs, str, loadProfile, baseUrlFor } from './common.js';

/**
 * Recompile an artifact from a saved discovery recording, with no model and no browser.
 *
 * This exists because the artifact is a *derived* document. Being able to regenerate it
 * from the recording proves the separation is real rather than asserted, and it means
 * iterating on the schema or the locator strategy costs nothing — you are not re-paying
 * for a discovery run every time you change how a target is computed.
 */
const args = parseArgs();
const recordingPath = str(args, 'recording', '');
if (!recordingPath) {
  console.error('usage: npm run compile -- --recording evidence/discovery-<id>/recording.json');
  process.exit(2);
}

const rec = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));

/**
 * Reviewer overrides. The model proposes each output's sensitivity; a human reviewing the
 * capability may raise it — never lower it — and the override is recorded in provenance
 * so the artifact says who decided. `--raise member_name=regulated`.
 */
const ORDER = { public: 0, internal: 1, regulated: 2, secret: 3 } as const;
const raises = ([] as string[]).concat((args.raise as string[] | string | undefined) ?? []).map(r => r.split('=') as [string, keyof typeof ORDER]);
for (const [name, level] of raises) {
  const out = (rec.outputs as Array<{ name: string; sensitivity: keyof typeof ORDER }>).find(o => o.name === name);
  if (!out) { console.error(`--raise: no output named ${name}`); process.exit(2); }
  if (ORDER[level] < ORDER[out.sensitivity]) { console.error(`--raise may only raise: ${name} is already ${out.sensitivity}`); process.exit(2); }
  out.sensitivity = level;
}
const profile = loadProfile(str(args, 'profile', 'profiles/portal.json'));
const tenant = str(args, 'tenant', 'tenant-a');

const artifact = CapabilityArtifact.parse(compile({
  capability: rec.capability,
  inputs: rec.inputs,
  outputs: rec.outputs,
  actions: rec.actions,
  successText: rec.successText,
  declaredOutcomes: rec.declaredOutcomes,
  profile: { ...profile, baseUrl: baseUrlFor(tenant) },
  provenance: { discoveryModel: rec.model, discoveryRunId: path.basename(path.dirname(recordingPath)), tenantId: tenant, evidenceDir: path.dirname(recordingPath) },
}));

/**
 * A reviewer may also declare a business outcome the model never encountered. Discovery
 * probes what it thinks of; a restricted record it never searched for stays unknown, and
 * replay reports it as a hard failure with the screen text in `observed`. Turning that
 * into a typed outcome is a three-field edit to a reviewable document, not a re-record:
 * `--outcome ACCESS_RESTRICTED="Authorization required"`.
 */
const outcomes = ([] as string[]).concat((args.outcome as string[] | string | undefined) ?? []).map(o => {
  const eq = o.indexOf('='); if (eq < 0) { console.error(`--outcome expects CODE="on-screen text"`); process.exit(2); }
  return { code: o.slice(0, eq), text: o.slice(eq + 1) };
});
for (const o of outcomes) {
  artifact.businessOutcomes.push({
    code: o.code, description: `Reviewer-declared: the screen reads "${o.text}".`, terminal: true, partialOutputs: [],
    detect: { description: `${o.code}: "${o.text}" on screen`, all: [{ kind: 'text_present', text: { kind: 'const', value: o.text }, match: 'contains' }], timeoutMs: 2000, pollMs: 250 },
  });
}
const reviewNotes = [
  raises.length ? `Reviewer raised sensitivity: ${raises.map(([n, l]) => `${n}→${l}`).join(', ')}.` : '',
  outcomes.length ? `Reviewer declared outcomes: ${outcomes.map(o => o.code).join(', ')}.` : '',
].filter(Boolean).join(' ');
if (reviewNotes) artifact.provenance.notes = `${artifact.provenance.notes ?? ''} ${reviewNotes}`.trim();
const out = str(args, 'out', path.join('artifacts', `${artifact.capability.id}.json`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
console.log(`recompiled ${artifact.capability.id} -> ${out} (${artifact.steps.length} steps, no API call)`);
