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

const out = str(args, 'out', path.join('artifacts', `${artifact.capability.id}.json`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
console.log(`recompiled ${artifact.capability.id} -> ${out} (${artifact.steps.length} steps, no API call)`);
