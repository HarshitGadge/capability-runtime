import fs from 'node:fs';
import path from 'node:path';
import type { Observation } from '../schema/observation.js';
import type { Redactor } from '../policy/redaction.js';

export type EventKind =
  | 'run_started' | 'run_finished'
  | 'step_started' | 'step_succeeded' | 'step_failed' | 'step_retry'
  | 'observation' | 'locator_resolved' | 'policy_denied' | 'confirmation_required'
  | 'business_outcome' | 'recovery_triggered' | 'recovery_applied'
  | 'checkpoint_passed' | 'checkpoint_failed'
  | 'llm_request' | 'llm_response' | 'llm_tool_call'
  | 'escalation_raised' | 'control_ceded' | 'human_action' | 'control_returned'
  | 'note';

/**
 * Evidence writer.
 *
 * One append-only JSONL stream per run plus richer artefacts on demand. JSONL because
 * the two things anyone actually does with a run log are `grep` it and replay it into
 * a table, and both stay possible when the run crashes halfway through — which is
 * precisely when the log matters.
 *
 * Everything written here passes through the redactor first. There is no "log the raw
 * thing just this once" path, because that is how regulated data ends up in a log
 * aggregator.
 */
export class EvidenceRecorder {
  readonly dir: string;
  private readonly stream: fs.WriteStream;
  private seq = 0;

  constructor(readonly runId: string, kind: 'discovery' | 'replay', private readonly redactor: Redactor, root = 'evidence') {
    this.dir = path.resolve(root, `${kind}-${runId}`);
    fs.mkdirSync(path.join(this.dir, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'observations'), { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, 'run.jsonl'), { flags: 'a' });
  }

  event(kind: EventKind, data: Record<string, unknown> = {}): void {
    const record = { seq: ++this.seq, at: new Date().toISOString(), kind, ...this.redactor.redactDeep(data, 'evidence') };
    this.stream.write(JSON.stringify(record) + '\n');
  }

  async screenshot(surface: { screenshot(): Promise<Buffer> }, label: string): Promise<string> {
    const file = path.join(this.dir, 'screenshots', `${String(this.seq).padStart(3, '0')}-${label.replace(/\W+/g, '-')}.png`);
    const png = await surface.screenshot();
    if (png.length) fs.writeFileSync(file, png);
    return path.relative(process.cwd(), file);
  }

  /** Full observation snapshot. The DOM-snapshot equivalent for a surface-agnostic system. */
  observation(obs: Observation, label: string): string {
    const file = path.join(this.dir, 'observations', `${String(this.seq).padStart(3, '0')}-${label.replace(/\W+/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(this.redactor.redactDeep(obs, 'evidence'), null, 2));
    return path.relative(process.cwd(), file);
  }

  /** The richer signal required on failure: screenshot + observation + the run's own tail. */
  async failureBundle(surface: { screenshot(): Promise<Buffer> }, obs: Observation | null, label: string): Promise<{ screenshotPath: string; observationPath?: string }> {
    const screenshotPath = await this.screenshot(surface, `FAIL-${label}`);
    const observationPath = obs ? this.observation(obs, `FAIL-${label}`) : undefined;
    return { screenshotPath, observationPath };
  }

  writeJson(name: string, value: unknown, redact = true): string {
    const file = path.join(this.dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(redact ? this.redactor.redactDeep(value, 'evidence') : value, null, 2));
    return path.relative(process.cwd(), file);
  }

  relDir(): string { return path.relative(process.cwd(), this.dir); }
  close(): void { this.stream.end(); }
}
