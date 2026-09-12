import type { Surface, ResolveResult } from '../surface/surface.js';
import type { Observation, UiElement } from '../schema/observation.js';
import type { ElementTarget } from '../schema/locator.js';
import type { Allowlist } from '../schema/artifact.js';
import type { ActionKind, RiskClass } from '../schema/step.js';
import { riskExceeds } from './risk.js';
import { Redactor } from './redaction.js';
import { automationMayAct } from '../escalation/lease.js';

export class PolicyViolation extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PolicyViolation'; }
}
/** Not a violation: a permitted action that policy requires a person to authorize. */
export class ConfirmationRequired extends Error {
  constructor(readonly risk: RiskClass, message: string) { super(message); this.name = 'ConfirmationRequired'; }
}

export interface GateContext {
  risk: RiskClass;
  stepId: string;
  intent: string;
}

/**
 * The single chokepoint. Every action taken by this system — by the discovery agent
 * exploring, by the replay engine executing, by a recovery rule dismissing a banner —
 * passes through this object.
 *
 * It is a decorator over `Surface` rather than a set of checks called by the runners,
 * and that is the whole point: there is no code path that can act on the surface while
 * bypassing policy, because there is no other reference to the underlying surface. A
 * guardrail you have to remember to call is not a guardrail.
 *
 * Four things are enforced here:
 *   - navigation confined to allowlisted origins and path prefixes
 *   - action verbs confined to those the capability declares
 *   - risk ceiling: anything above `maxUnattendedRisk` raises ConfirmationRequired,
 *     which the caller routes to a human rather than swallowing
 *   - the control lease: automation does not act while a person holds the session
 */
export class PolicyGate implements Surface {
  private ctx: GateContext = { risk: 'safe', stepId: '(none)', intent: '' };
  /** Step ids a human has authorized once. Consumed on use — never a standing grant. */
  private readonly authorized = new Set<string>();
  readonly denials: Array<{ code: string; detail: string; at: string }> = [];
  readonly authorizations: Array<{ stepId: string; at: string }> = [];

  constructor(
    private readonly inner: Surface,
    private readonly allowlist: Allowlist,
    readonly redactor: Redactor,
    /** When false, risky actions are blocked outright instead of routed for confirmation. */
    private readonly allowEscalation = true,
  ) {}

  get kind() { return this.inner.kind; }
  get providerId() { return this.inner.providerId; }

  /** Runners set the context before each step; it is what the checks below are about. */
  withContext(ctx: GateContext): this { this.ctx = ctx; return this; }

  /**
   * Record that a human authorized one execution of one step.
   *
   * Deliberately single-use and step-scoped. A human approving "open this sub-account
   * for member 12345 now" has not approved every sub-account opening for the rest of the
   * run, and a grant that outlives its use is how an approval gate quietly becomes a
   * rubber stamp. The grant is consumed the moment it is spent, and every grant is
   * written to evidence.
   */
  authorizeOnce(stepId: string): void {
    this.authorized.add(stepId);
    this.authorizations.push({ stepId, at: new Date().toISOString() });
  }

  private deny(code: string, detail: string): never {
    this.denials.push({ code, detail, at: new Date().toISOString() });
    throw new PolicyViolation(code, detail);
  }

  private checkLease(): void {
    if (!automationMayAct()) {
      this.deny('LEASE_HELD_BY_HUMAN', `A human holds the session lease; automation must not act during step ${this.ctx.stepId}`);
    }
  }

  private checkVerb(kind: ActionKind): void {
    if (!this.allowlist.actions.includes(kind)) {
      this.deny('ACTION_NOT_ALLOWED', `Action "${kind}" is not in this capability's allowlist [${this.allowlist.actions.join(', ')}]`);
    }
  }

  private checkRisk(): void {
    if (!riskExceeds(this.ctx.risk, this.allowlist.maxUnattendedRisk)) return;
    if (this.authorized.delete(this.ctx.stepId)) return;
    const msg = `Step ${this.ctx.stepId} ("${this.ctx.intent}") is classified ${this.ctx.risk}, above the unattended ceiling ${this.allowlist.maxUnattendedRisk}`;
    if (!this.allowEscalation) this.deny('RISK_CEILING_EXCEEDED', msg);
    throw new ConfirmationRequired(this.ctx.risk, msg);
  }

  /**
   * URL admission. Checked on explicit navigation *and* re-checked after every action,
   * because a click can navigate: an allowlist that only guards `navigate` is trivially
   * escaped by any link on the page.
   */
  checkUrl(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); } catch { this.deny('URL_UNPARSEABLE', `Cannot parse URL: ${url}`); }
    if (parsed!.protocol === 'about:' || url === 'about:blank') return;
    if (!this.allowlist.origins.includes(parsed!.origin)) {
      this.deny('ORIGIN_NOT_ALLOWED', `Origin ${parsed!.origin} is not in the allowlist [${this.allowlist.origins.join(', ')}]`);
    }
    if (!this.allowlist.pathPrefixes.some(p => parsed!.pathname.startsWith(p))) {
      this.deny('PATH_NOT_ALLOWED', `Path ${parsed!.pathname} is outside the allowed prefixes [${this.allowlist.pathPrefixes.join(', ')}]`);
    }
  }

  private async assertLandedInsideAllowlist(): Promise<void> {
    this.checkUrl(await this.inner.currentUrl());
  }

  async observe(): Promise<Observation> {
    const obs = await this.inner.observe();
    this.checkUrl(obs.url);
    return obs;
  }

  /** Observation as the model is allowed to see it: regulated values already tokenized. */
  async observeForModel(): Promise<Observation> {
    return this.redactor.redactDeep(await this.observe(), 'llm');
  }

  screenshot(): Promise<Buffer> { return this.inner.screenshot(); }
  resolve(t: ElementTarget, o: Observation, b: Record<string, unknown>): Promise<ResolveResult> { return this.inner.resolve(t, o, b); }
  currentUrl(): Promise<string> { return this.inner.currentUrl(); }
  close(): Promise<void> { return this.inner.close(); }

  async click(el: UiElement): Promise<void> {
    this.checkLease(); this.checkVerb('click'); this.checkRisk();
    await this.inner.click(el);
    await this.assertLandedInsideAllowlist();
  }

  async type(el: UiElement, text: string, clearFirst: boolean): Promise<void> {
    this.checkLease(); this.checkVerb('type'); this.checkRisk();
    // The model works in tokens; the real value is substituted here, at the boundary,
    // so a regulated value re-enters the page without ever having left the process.
    await this.inner.type(el, this.redactor.reveal(text), clearFirst);
  }

  async select(el: UiElement, value: string): Promise<void> {
    this.checkLease(); this.checkVerb('select'); this.checkRisk();
    await this.inner.select(el, this.redactor.reveal(value));
    await this.assertLandedInsideAllowlist();
  }

  async press(key: string): Promise<void> {
    this.checkLease(); this.checkVerb('press'); this.checkRisk();
    await this.inner.press(key);
    await this.assertLandedInsideAllowlist();
  }

  async navigate(url: string): Promise<void> {
    this.checkLease(); this.checkVerb('navigate');
    this.checkUrl(url);
    await this.inner.navigate(url);
    await this.assertLandedInsideAllowlist();
  }
}
