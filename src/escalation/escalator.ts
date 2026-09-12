import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Observation } from '../schema/observation.js';
import { SESSION_DIR, readSession } from './session.js';
import { cedeToHuman, readLease, returnToAutomation } from './lease.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { Redactor } from '../policy/redaction.js';

export const INBOX_DIR = path.join(SESSION_DIR, 'interventions');

export interface InterventionContext {
  capabilityId: string;
  capabilityVersion: string;
  runId: string;
  tenantId: string;
  stepId: string;
  stepIntent: string;
  reason: string;
  observation: Observation | null;
  bindings: Record<string, unknown>;
}

export interface InterventionRequest extends Omit<InterventionContext, 'observation'> {
  id: string;
  createdAt: string;
  status: 'open' | 'claimed' | 'resolved' | 'abandoned';
  /** Where the human plugs in. Without this, "take control" is a slogan. */
  session: { cdpEndpoint: string; shared: boolean } | null;
  screenshotPath?: string;
  observationPath?: string;
  /** A short, redacted description of the screen, so an operator can triage without opening it. */
  screenSummary: string;
  resumeToken: string;
  /** Filled in by the operator console. */
  resolution?: 'resumed' | 'abandoned';
  operatorNote?: string;
  /** The operator performed the blocked step by hand; automation must not repeat it. */
  operatorDidStep?: boolean;
  /** The operator authorized automation to perform the blocked step, once. */
  operatorAuthorizedStep?: boolean;
  humanActions?: Array<{ at: string; kind: string; detail: string }>;
}

export interface HandoffResult {
  interventionId: string;
  resolution: 'resumed' | 'abandoned';
  resumable: boolean;
  resumeToken: string;
  note?: string;
  /** True when the operator says they completed the blocked step themselves. */
  skipStep?: boolean;
  /** True when the operator authorized one execution of the blocked step. */
  authorizeStep?: boolean;
  humanActions?: Array<{ at: string; kind: string; detail: string }>;
}

export interface EscalatorOptions {
  recorder: EvidenceRecorder;
  redactor: Redactor;
  /** How long to hold the run open waiting for a person. 0 means "file it and return". */
  waitMs: number;
  screenshot?: () => Promise<Buffer>;
  /** Attach a recorder to the live page so the human's own actions land in evidence. */
  watchHumanActions?: (onAction: (kind: string, detail: string) => void) => Promise<() => Promise<void>>;
}

/**
 * Detect-route-handoff-resume.
 *
 * The interesting part is not the queue — it is the three properties that make the
 * handoff real rather than a TODO:
 *
 *  1. The request carries enough to act on: which capability, which step and why, the
 *    screen as both a picture and a structured observation, and the CDP endpoint of the
 *    *live* session. An operator does not reproduce anything; they open the window the
 *    automation was already in.
 *
 *  2. Control genuinely transfers. The lease flips to `human`, and the policy gate
 *    refuses every automation action while it is held. The run is suspended, not racing
 *    the person who is trying to help it.
 *
 *  3. Resume is verified, never assumed. When control comes back the engine re-observes
 *    and re-evaluates the blocked step's precondition. If the operator moved the session
 *    somewhere unexpected, that surfaces as a precondition failure rather than a click
 *    landing on whatever now occupies those coordinates.
 *
 * What is mocked: the operator console is a small local web page, not a co-browsing
 * product. What is real: the request, the context, the lease, the transfer, the capture
 * of what the human did, and the verified resume.
 */
export class Escalator {
  constructor(private readonly opts: EscalatorOptions) {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  private file(id: string): string { return path.join(INBOX_DIR, `${id}.json`); }

  static read(id: string): InterventionRequest | null {
    try { return JSON.parse(fs.readFileSync(path.join(INBOX_DIR, `${id}.json`), 'utf8')); } catch { return null; }
  }
  static list(): InterventionRequest[] {
    if (!fs.existsSync(INBOX_DIR)) return [];
    return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(INBOX_DIR, f), 'utf8')) as InterventionRequest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  static write(req: InterventionRequest): void {
    fs.writeFileSync(path.join(INBOX_DIR, `${req.id}.json`), JSON.stringify(req, null, 2));
  }

  async request(ctx: InterventionContext): Promise<HandoffResult> {
    const { recorder, redactor } = this.opts;
    const id = 'INT-' + crypto.randomUUID().slice(0, 8);
    const resumeToken = crypto.randomUUID();
    const session = readSession();

    const screenshotPath = this.opts.screenshot ? await recorder.screenshot({ screenshot: this.opts.screenshot }, `escalation-${id}`) : undefined;
    const observationPath = ctx.observation ? recorder.observation(ctx.observation, `escalation-${id}`) : undefined;

    const req: InterventionRequest = {
      id,
      createdAt: new Date().toISOString(),
      status: 'open',
      capabilityId: ctx.capabilityId,
      capabilityVersion: ctx.capabilityVersion,
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      stepId: ctx.stepId,
      stepIntent: ctx.stepIntent,
      reason: ctx.reason,
      bindings: redactor.redactDeep(ctx.bindings, 'evidence'),
      session: session ? { cdpEndpoint: session.cdpEndpoint, shared: true } : null,
      screenshotPath,
      observationPath,
      screenSummary: summarize(ctx.observation, redactor),
      resumeToken,
    };
    Escalator.write(req);
    recorder.event('escalation_raised', { interventionId: id, stepId: ctx.stepId, reason: ctx.reason, screenshotPath, shared: !!session });

    // Cede the session. From here until a human returns it, the gate blocks automation.
    cedeToHuman(id, `${ctx.capabilityId} step ${ctx.stepId}: ${ctx.reason}`);
    recorder.event('control_ceded', { interventionId: id, holder: 'human' });

    const stopWatching = this.opts.watchHumanActions
      ? await this.opts.watchHumanActions((kind, detail) => {
          const current = Escalator.read(id);
          if (!current) return;
          current.humanActions = [...(current.humanActions ?? []), { at: new Date().toISOString(), kind, detail: redactor.redact(detail, 'evidence') }];
          Escalator.write(current);
        })
      : null;

    const settled = await this.awaitResolution(id, this.opts.waitMs);
    await stopWatching?.().catch(() => {});

    if (!settled) {
      // Nobody came. The run reports `escalated` and stays resumable; the session and
      // the request both outlive this process, which is the point of the design.
      return { interventionId: id, resolution: 'abandoned', resumable: true, resumeToken };
    }

    if (settled.resolution === 'resumed') {
      if (readLease().holder !== 'automation') returnToAutomation('auto-return on resume');
      return {
        interventionId: id, resolution: 'resumed', resumable: true, resumeToken,
        note: settled.operatorNote, skipStep: settled.operatorDidStep,
        authorizeStep: settled.operatorAuthorizedStep, humanActions: settled.humanActions,
      };
    }
    return { interventionId: id, resolution: 'abandoned', resumable: true, resumeToken, note: settled.operatorNote };
  }

  private async awaitResolution(id: string, waitMs: number): Promise<InterventionRequest | null> {
    if (waitMs <= 0) return null;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const req = Escalator.read(id);
      if (req && (req.status === 'resolved' || req.status === 'abandoned')) return req;
      await new Promise(r => setTimeout(r, 750));
    }
    return null;
  }
}

/** Terse, redacted description of the screen for operator triage. */
function summarize(obs: Observation | null, redactor: Redactor): string {
  if (!obs) return 'No observation captured.';
  const controls = obs.elements
    .filter(e => ['button', 'link', 'textbox', 'combobox'].includes(e.role))
    .slice(0, 12)
    .map(e => `${e.role}:"${e.name || e.proximityLabel || e.text || ''}"`)
    .join(', ');
  const text = redactor.redact(Object.values(obs.textByFrame).join(' ').slice(0, 300), 'evidence');
  return `${obs.title} | ${text} | controls: ${controls}`;
}
