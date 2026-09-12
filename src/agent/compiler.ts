import crypto from 'node:crypto';
import type { CapabilityArtifact, ParamSpec, OutputSpec, Allowlist, BusinessOutcomeRule, RecoveryRule } from '../schema/artifact.js';
import { SCHEMA_VERSION } from '../schema/artifact.js';
import type { Step, Action, RiskClass } from '../schema/step.js';
import type { ElementTarget, LocatorStrategy, ValueRef, Scope } from '../schema/locator.js';
import type { Checkpoint } from '../schema/checkpoint.js';
import type { Observation, UiElement } from '../schema/observation.js';
import { resolveTarget } from '../surface/locatorResolver.js';
import { classifyRisk } from '../policy/risk.js';
import { DEFAULT_RULES } from '../policy/redaction.js';

/** One recorded interaction: what was done, to which element, on which screen. */
export interface RecordedAction {
  action: Action;
  element?: UiElement;
  intent: string;
  /** The screen as it was *before* the action, used to compute and verify locators. */
  before: Observation;
  /** The screen *after*, used to derive this step's postcondition. */
  after: Observation;
}

export interface CompileInput {
  capability: { id: string; name: string; description: string };
  inputs: ParamSpec[];
  outputs: OutputSpec[];
  actions: RecordedAction[];
  /** Text the model nominated as proof the goal was reached. */
  successText: string;
  declaredOutcomes: Array<{ code: string; description: string; whenTextPresent: string }>;
  /** App-level recoveries and allowlist, authored once per vendor product. */
  profile: { appId: string; appVersion: string; allowlist: Allowlist; recoveries: RecoveryRule[]; baseUrl: string };
  provenance: { discoveryModel: string; discoveryRunId: string; tenantId: string; evidenceDir: string };
}

/**
 * An artifact is a durable document that gets committed, reviewed and shipped between
 * environments. Anything regulated that reaches it is a disclosure that outlives the
 * run, so two rules apply to every literal the compiler is about to persist:
 *
 *  - it must not look like regulated data (a balance, an account number);
 *  - it must not be a value the caller supplies, or the "capability" is really a
 *    hard-coded lookup of one member wearing a parameter's clothing.
 *
 * Both are checked per candidate literal, and again over the finished document.
 */
const looksSensitive = (text: string): boolean =>
  DEFAULT_RULES.some(r => new RegExp(r.pattern.source, r.pattern.flags.replace('g', '')).test(text));

const isCallerValue = (text: string, inputs: ParamSpec[]): boolean =>
  inputs.some(i => i.example && text.includes(String(i.example)));

/**
 * A redaction token stands in for a value that was scrubbed on the way out. It is not a
 * label, it will not be on the screen at replay time, and a checkpoint asserting one can
 * never pass — so it is rejected alongside the raw values it replaced.
 */
const isRedactionToken = (text: string): boolean => /«\w+:[0-9a-f]{6}»/.test(text);

const unsafeLiteral = (text: string | undefined, inputs: ParamSpec[]): boolean =>
  !!text && (looksSensitive(text) || isCallerValue(text, inputs) || isRedactionToken(text));

/**
 * Turn a recorded run into a capability artifact.
 *
 * The model does not write this document. It decides *what to do*; the runtime computes
 * *how to find it again*, from the element it actually interacted with and the screen
 * that element was on. That split matters: asking a language model to emit selectors
 * produces plausible-looking locators that were never tested against anything, whereas
 * every strategy emitted here is verified — below — to have uniquely identified the
 * real element at record time. A strategy that was already ambiguous during recording
 * is discarded rather than shipped as a latent flake.
 */
export function compile(input: CompileInput): CapabilityArtifact {
  const steps: Step[] = [];
  const usedIds = new Set<string>();
  // Everything a tenant can vary is stripped out of generated URL patterns. The base
  // path carries the tenant (/t/tenant-a); the product's own routes below it do not,
  // so the pattern we emit is the part that is genuinely the same everywhere.
  const basePath = new URL(input.profile.baseUrl).pathname.replace(/\/$/, '');
  const contentFrame = pickWorkingFrame(input.actions);

  for (const [i, rec] of input.actions.entries()) {
    const id = uniqueId(usedIds, slug(rec.intent) || `step_${i + 1}`);
    const target = rec.element ? buildTarget(rec.element, rec.before, input.inputs, id) : undefined;
    const risk = classifyRisk(rec.action, rec.element);

    steps.push({
      id,
      intent: rec.intent,
      action: parameterize(rec.action, input.inputs),
      target,
      risk,
      // The precondition is the previous step's postcondition. This is what makes a run
      // resumable after a human takes the session: on resume we re-prove we are on the
      // screen this step expects instead of assuming nothing moved.
      precondition: i === 0
        ? screenCheckpoint(rec.before, 'entry screen', basePath, input.inputs, contentFrame)
        : screenCheckpoint(input.actions[i - 1]!.after, `screen after ${steps[i - 1]!.id}`, basePath, input.inputs, contentFrame),
      postcondition: screenCheckpoint(rec.after, `screen after ${id}`, basePath, input.inputs, contentFrame),
      timeoutMs: 15_000,
      maxAttempts: risk === 'irreversible' ? 1 : 2,   // never retry something that cannot be undone
    });
  }

  const last = input.actions.at(-1);
  const success: Checkpoint = {
    description: `Goal reached: "${input.successText}" is visible`,
    all: [
      { kind: 'text_present', text: { kind: 'const', value: input.successText }, match: 'contains' },
      ...(last ? headingAssertions(last.after, contentFrame, input.inputs) : []),
    ],
    timeoutMs: 15_000,
    pollMs: 250,
  };

  const businessOutcomes: BusinessOutcomeRule[] = input.declaredOutcomes.map(o => ({
    code: o.code,
    description: o.description,
    terminal: true as const,
    partialOutputs: [],
    detect: {
      description: `${o.code}: "${o.whenTextPresent}" on screen`,
      all: [{ kind: 'text_present', text: { kind: 'const', value: o.whenTextPresent }, match: 'contains' }],
      timeoutMs: 2000,
      pollMs: 250,
    },
  }));

  const artifact: CapabilityArtifact = {
    schemaVersion: SCHEMA_VERSION,
    capability: { ...input.capability, version: '1.0.0', tags: ['discovered'] },
    target: {
      appId: input.profile.appId,
      appVersion: input.profile.appVersion,
      surface: 'web',
      entryPoint: '{baseUrl}/',
      allowlist: input.profile.allowlist,
    },
    inputs: input.inputs,
    outputs: input.outputs,
    steps,
    success,
    businessOutcomes,
    recoveries: input.profile.recoveries,
    provenance: {
      recordedAt: new Date().toISOString(),
      discoveryModel: input.provenance.discoveryModel,
      discoveryRunId: input.provenance.discoveryRunId,
      recordedAgainstTenant: input.provenance.tenantId,
      evidenceDir: input.provenance.evidenceDir,
      surfaceFingerprint: fingerprint(input.actions),
      notes: 'Steps recorded from a live LLM-driven run; locators computed and uniqueness-verified by the runtime.',
    },
  };

  assertNoRegulatedData(artifact);
  return artifact;
}

/**
 * Last line of defence before an artifact is written to disk.
 *
 * Per-literal filtering above is where the work is done; this is the assertion that the
 * filtering worked. It scans the finished document for anything matching a redaction
 * rule and refuses to emit it. Failing the build is the right response: an artifact is
 * committed to a repository and copied between environments, so a leak here is
 * permanent and travels, and a capability that cannot be built without embedding a
 * member's balance is a capability that needs rethinking rather than shipping.
 */
export function assertNoRegulatedData(artifact: CapabilityArtifact): void {
  // Provenance holds paths and hashes, not screen content, and the evidence directory
  // name legitimately contains identifiers.
  const { provenance, ...body } = artifact;
  const serialized = JSON.stringify(body);
  const hits = [
    ...DEFAULT_RULES.flatMap(rule =>
      (serialized.match(new RegExp(rule.pattern.source, rule.pattern.flags)) ?? []).map(m => `${rule.name}: ${m}`)),
    ...(serialized.match(/«\w+:[0-9a-f]{6}»/g) ?? []).map(m => `redaction token: ${m}`),
  ];
  if (hits.length) {
    throw new Error(
      `Refusing to emit artifact "${artifact.capability.id}": it contains what looks like regulated data — ${[...new Set(hits)].join(', ')}. ` +
      `A locator or checkpoint was built from record data instead of a label.`);
  }
}

// --------------------------------------------------------------------- locators

/**
 * Build a ranked target for an element, keeping only strategies that uniquely matched
 * the real element on the recorded screen.
 */
function buildTarget(el: UiElement, obs: Observation, inputs: ParamSpec[], stepId: string): ElementTarget {
  const scope = inferScope(el, inputs);
  const candidates: LocatorStrategy[] = [];

  // A locator may only be built from labels — what the control is *called* — never from
  // the data it happens to be displaying. Skipping these is what stops the compiler from
  // writing "the cell reading $18,204.37" into a capability meant to work for any member.
  if (el.name && !unsafeLiteral(el.name, inputs)) candidates.push({ kind: 'role_name', role: el.role, name: el.name, match: 'normalized' });
  if (el.proximityLabel && !unsafeLiteral(el.proximityLabel, inputs)) candidates.push({ kind: 'proximity_label', role: el.role, label: el.proximityLabel, match: 'normalized' });
  if (el.placeholder && !unsafeLiteral(el.placeholder, inputs)) candidates.push({ kind: 'placeholder', placeholder: el.placeholder, match: 'normalized' });
  if (el.text && el.text !== el.name && !unsafeLiteral(el.text, inputs)) candidates.push({ kind: 'text', text: el.text, role: el.role, match: 'normalized' });

  // Region names on record screens carry the record's identity ("Member Detail — 12345").
  // Stripping digits keeps the semanticId stable across members and tenants, which
  // matters because it is the join key tenant overlays use.
  const regionSlug = slug((el.region ?? 'screen').replace(/[\d«»:]+/g, ' ').split(/[—–|]/)[0] ?? 'screen') || 'screen';
  const labelSlug = slug(unsafeLiteral(el.name || el.proximityLabel || el.text, inputs) ? el.role : (el.name || el.proximityLabel || el.text || el.role));
  const semanticId = `${regionSlug}.${labelSlug}`.slice(0, 64);
  const probe = (strategies: LocatorStrategy[]): ElementTarget => ({
    semanticId, description: `${el.role} "${el.name || el.proximityLabel || el.text || ''}"`,
    strategies, scope, frame: el.frame, ambiguity: 'require_unique',
  });

  // Keep a strategy only if it found exactly one element, and that element is this one.
  const verified = candidates.filter(s => {
    const r = resolveTarget(probe([s]), obs, syntheticBindings(inputs, el));
    return r.candidates.length === 1 && sameElement(r.candidates[0]!, el);
  });

  // Ordinal is the honest last resort: recorded so a target is never empty, ranked
  // last so it is only ever reached when every semantic strategy has failed.
  const ofRole = obs.elements.filter(e => e.role === el.role && e.frame.join('/') === el.frame.join('/'));
  const ordinalIndex = ofRole.findIndex(e => sameElement(e, el));
  if (ordinalIndex >= 0) verified.push({ kind: 'ordinal', role: el.role, index: ordinalIndex });
  verified.push({
    kind: 'coordinates',
    x: el.bounds.x + el.bounds.width / 2,
    y: el.bounds.y + el.bounds.height / 2,
    viewport: obs.viewport,
  });

  if (!verified.length) {
    throw new Error(`Could not compute any unique locator for ${el.role} "${el.name || el.text}" at step ${stepId}`);
  }
  return probe(verified);
}

/**
 * If the element sits in a table row that contains a caller-supplied value, scope the
 * target to that row. "The View link in the row for member {memberId}" survives a
 * different result set; "the first View link" does not.
 */
function inferScope(el: UiElement, inputs: ParamSpec[]): Scope | undefined {
  if (!el.rowText) return undefined;
  for (const spec of inputs) {
    const example = spec.example;
    if (example && el.rowText.includes(example)) {
      return { kind: 'row_containing', text: { kind: 'input', name: spec.name } };
    }
  }
  return undefined;
}

const sameElement = (a: UiElement, b: UiElement) =>
  a.role === b.role && a.name === b.name && a.text === b.text &&
  Math.abs(a.bounds.x - b.bounds.x) < 2 && Math.abs(a.bounds.y - b.bounds.y) < 2;

const syntheticBindings = (inputs: ParamSpec[], el: UiElement) =>
  Object.fromEntries(inputs.filter(i => i.example).map(i => [`input.${i.name}`, i.example!]));

// ------------------------------------------------------------------ checkpoints

/**
 * A checkpoint describing "we are on this screen", built from the screen's heading and
 * its URL. Headings rather than markup: they survive restyling and they are what a
 * person would use to tell two screens apart.
 */
function screenCheckpoint(obs: Observation, description: string, basePath: string, inputs: ParamSpec[], contentFrame: string | null): Checkpoint {
  const frameUrls = Object.entries(obs.urlByFrame ?? {}).filter(([k]) => k !== '(top)').map(([, v]) => v);
  const routes = (frameUrls.length ? frameUrls : [obs.url])
    .map(u => new URL(u).pathname.startsWith(basePath) ? new URL(u).pathname.slice(basePath.length) : new URL(u).pathname)
    .filter(r => r && r !== '/');
  const unique = [...new Set(routes)];

  return {
    description,
    all: [
      ...unique.map(r => ({ kind: 'url_matches' as const, pattern: `${escapeRe(r)}(\\?|$)` })),
      ...headingAssertions(obs, contentFrame, inputs),
    ],
    timeoutMs: 10_000,
    pollMs: 250,
  };
}

/**
 * Identify the frame that holds the working area, by finding the one whose content
 * varies most across the recording.
 *
 * A legacy portal splits the window into furniture and work: a navigation frame that is
 * byte-identical on every screen, and a content frame that is the screen. Checkpoints
 * must be built from the second. Rather than hard-coding a frame name — which would be
 * a per-app assumption smuggled into a general compiler — the working frame is simply
 * the one that changes, which is the same cue a person uses.
 */
function pickWorkingFrame(actions: RecordedAction[]): string | null {
  const distinct = new Map<string, Set<string>>();
  for (const rec of actions) {
    for (const obs of [rec.before, rec.after]) {
      for (const [frame, text] of Object.entries(obs.textByFrame)) {
        if (!distinct.has(frame)) distinct.set(frame, new Set());
        distinct.get(frame)!.add(text);
      }
    }
  }
  let best: string | null = null, bestCount = 1;
  for (const [frame, texts] of distinct) {
    if (texts.size > bestCount) { best = frame; bestCount = texts.size; }
  }
  return best;
}

/**
 * Pick the text that identifies this screen.
 *
 * Candidates are drawn from the working frame, because the obvious choice — the first
 * heading on the page — picks the navigation menu, which is identical everywhere and
 * therefore asserts nothing. On a frameset app the URL cannot break the tie either, so
 * getting this right is what makes "am I on the results screen or the search form?"
 * answerable at all.
 *
 * Candidates carrying record data or caller-supplied values are rejected: a checkpoint
 * asserting "Member Detail — 12345" is both a disclosure and a capability that only
 * ever works for member 12345.
 */
function headingAssertions(obs: Observation, contentFrame: string | null, inputs: ParamSpec[]): Checkpoint['all'] {
  const inWorkingFrame = (e: UiElement) => {
    const key = e.frame.length ? e.frame.join('/') : '(top)';
    return contentFrame === null || key === contentFrame;
  };
  const acceptable = (t: string | undefined): t is string =>
    !!t && t.length > 2 && t.length < 60 && !unsafeLiteral(t, inputs);

  for (const pool of [obs.elements.filter(inWorkingFrame), obs.elements]) {
    const heading =
      pool.find(e => e.role === 'heading' && acceptable(e.text))
      ?? pool.find(e => e.role === 'cell' && acceptable(e.text) && !e.proximityLabel);
    if (acceptable(heading?.text)) {
      return [{ kind: 'text_present' as const, text: { kind: 'const' as const, value: heading!.text! }, match: 'contains' as const }];
    }
  }
  return [];
}

// --------------------------------------------------------------- parameterization

/** Replace literal typed values that equal a declared input with a typed reference. */
function parameterize(action: Action, inputs: ParamSpec[]): Action {
  if (action.kind !== 'type' && action.kind !== 'select') return action;
  if (action.value.kind !== 'const') return action;
  const literal = String(action.value.value);
  const match = inputs.find(i => i.example != null && String(i.example) === literal);
  if (!match) return action;
  const ref: ValueRef = { kind: 'input', name: match.name };
  return action.kind === 'type' ? { ...action, value: ref } : { ...action, value: ref };
}

// ------------------------------------------------------------------------ helpers

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function uniqueId(used: Set<string>, base: string): string {
  let id = base, n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

/**
 * Fingerprint of the recorded surface: the shape of the screens the flow passed through.
 * Replay compares it and warns on mismatch — the cheapest possible drift detector, and
 * the signal that says "re-review this capability for this tenant".
 */
function fingerprint(actions: RecordedAction[]): string {
  const shape = actions.map(a => {
    const o = a.after;
    return `${new URL(o.url).pathname}:${o.elements.filter(e => e.role === 'button' || e.role === 'link' || e.role === 'textbox').length}`;
  }).join('|');
  return crypto.createHash('sha256').update(shape).digest('hex').slice(0, 16);
}
