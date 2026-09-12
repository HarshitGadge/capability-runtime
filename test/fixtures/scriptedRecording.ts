import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrowserSurface } from '../../src/surface/browser/browserSurface.js';
import { Redactor } from '../../src/policy/redaction.js';
import type { RecordedAction } from '../../src/agent/compiler.js';
import type { DiscoveryRecording } from '../../src/agent/discover.js';
import type { Observation, UiElement } from '../../src/schema/observation.js';

/**
 * TEST FIXTURE ONLY — this is not the discovery path.
 *
 * It drives the same flow the model discovers, but from a fixed script, and emits a
 * `recording.json` in exactly the shape `discover()` produces. That gives the compiler
 * and the replay engine a deterministic input so their tests do not need an API key,
 * a model, or a network — and so a change to locator computation can be regressed in
 * milliseconds instead of dollars.
 *
 * The artifact shipped in /evidence comes from a real LLM run. This exists so the
 * *tests* do not.
 */
export async function recordScripted(opts: { baseUrl: string; memberId: string; headless?: boolean }): Promise<DiscoveryRecording> {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const surface = await BrowserSurface.attach(browser, page, 'dom-scan', true);
  const actions: RecordedAction[] = [];

  const find = (obs: Observation, pred: (e: UiElement) => boolean, what: string): UiElement => {
    const el = obs.elements.find(pred);
    if (!el) throw new Error(`fixture: could not find ${what} on ${obs.url}`);
    return el;
  };

  const step = async (intent: string, pick: (o: Observation) => UiElement | undefined, act: (el: UiElement) => Promise<void>, action: RecordedAction['action']) => {
    const before = await surface.observe();
    const el = pick(before);
    if (el) await act(el);
    const after = await surface.observe();
    actions.push({ intent, element: el, before, after, action });
  };

  await surface.navigate(`${opts.baseUrl}/`);

  // Session establishment, performed OUTSIDE the recording. Authentication belongs to
  // the app profile, so it must not become a step in the capability — see the note in
  // profiles/portal.json and src/replay/preflight.ts.
  {
    const o = await surface.observe();
    const signOn = o.elements.find(e => e.role === 'button' && /sign on/i.test(e.name));
    if (signOn) await surface.click(signOn);
  }

  await step('Enter the member identifier in the lookup form',
    o => find(o, e => e.role === 'textbox' && /member id|member number/i.test(e.proximityLabel ?? ''), 'member id field'),
    el => surface.type(el, opts.memberId, true),
    { kind: 'type', value: { kind: 'const', value: opts.memberId }, clearFirst: true });

  await step('Submit the member search',
    o => find(o, e => e.role === 'button' && /search|find member/i.test(e.name), 'search button'),
    el => surface.click(el), { kind: 'click' });

  await step('Open the matching member record from the results',
    o => find(o, e => e.role === 'link' && e.text === 'View', 'View link'),
    el => surface.click(el), { kind: 'click' });

  await step('Read the current savings balance from the member record',
    o => find(o, e => e.role === 'cell' && /savings balance/i.test(e.proximityLabel ?? ''), 'savings balance cell'),
    async () => {}, { kind: 'extract', extracts: [{ name: 'savings_balance', from: 'text', transform: 'currency_to_number' }] });

  await browser.close();

  return {
    goal: `Look up member ${opts.memberId} and read their current savings balance`,
    model: 'fixture/scripted',
    capability: {
      id: 'member.read_savings_balance',
      name: 'Read member savings balance',
      description: 'Look up a credit-union member by their member identifier and return the current balance of their savings account.',
    },
    inputs: [{
      name: 'memberId', type: 'string', required: true,
      description: 'The member identifier to look up.',
      sensitivity: 'internal', pattern: '^\\d{4,10}$', example: opts.memberId,
    }],
    outputs: [{
      name: 'savings_balance', type: 'currency', required: true,
      description: 'Current balance of the member savings account.',
      sensitivity: 'regulated',
    }],
    actions,
    declaredOutcomes: [
      { code: 'MEMBER_NOT_FOUND', description: 'No member record matches the supplied identifier.', whenTextPresent: 'No member found' },
      { code: 'ACCESS_RESTRICTED', description: 'The member record is flagged restricted and needs a supervisor override.', whenTextPresent: 'Authorization required' },
    ],
    successText: 'Member Detail',
    summary: 'Scripted fixture recording of the member savings balance lookup.',
    turns: 0,
    stopReason: 'goal_reached',
  };
}

// Move the runnable block to the end of the module so both recorders are defined.
export async function writeFixtures(baseUrl: string): Promise<void> {
  const jobs: Array<[string, Promise<DiscoveryRecording>]> = [
    ['fixture-read-balance', recordScripted({ baseUrl, memberId: '12345' })],
    ['fixture-open-subaccount', recordSubAccount({ baseUrl, memberId: '12345', accountType: 'Holiday Savings', deposit: '250.00' })],
  ];
  for (const [name, job] of jobs) {
    const rec = await job;
    const dir = path.resolve('evidence', name);
    fs.mkdirSync(dir, { recursive: true });
    // A recording is persisted evidence and holds two full observations per action, so
    // it goes through the redactor on the way to disk exactly as the discovery path does.
    // The compiler builds targets from labels, never from values, so it is unaffected —
    // which is the property being relied on, and worth stating rather than assuming.
    fs.writeFileSync(path.join(dir, 'recording.json'), JSON.stringify(new Redactor().redactDeep(rec, 'evidence'), null, 2));
    console.log(`fixture -> evidence/${name}/recording.json (${rec.actions.length} actions)`);
  }
}

/**
 * Second fixture: opening a sub-account. Its final step submits an account opening —
 * not undoable from inside the app — so it is the flow that exercises the risk ceiling
 * and the human-handoff path.
 */
export async function recordSubAccount(opts: { baseUrl: string; memberId: string; accountType: string; deposit: string; headless?: boolean }): Promise<DiscoveryRecording> {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  const surface = await BrowserSurface.attach(browser, page, 'dom-scan', true);
  const actions: RecordedAction[] = [];

  const find = (obs: Observation, pred: (e: UiElement) => boolean, what: string): UiElement => {
    const el = obs.elements.find(pred);
    if (!el) throw new Error(`fixture: could not find ${what} on ${obs.url}`);
    return el;
  };
  const step = async (intent: string, pick: (o: Observation) => UiElement | undefined, act: (el: UiElement) => Promise<void>, action: RecordedAction['action']) => {
    const before = await surface.observe();
    const el = pick(before);
    if (el) await act(el);
    const after = await surface.observe();
    actions.push({ intent, element: el, before, after, action });
  };

  await surface.navigate(`${opts.baseUrl}/`);
  {
    const o = await surface.observe();
    const signOn = o.elements.find(e => e.role === 'button' && /sign on/i.test(e.name));
    if (signOn) await surface.click(signOn);
  }

  await step('Enter the member identifier in the lookup form',
    o => find(o, e => e.role === 'textbox' && /member id|member number/i.test(e.proximityLabel ?? ''), 'member id field'),
    el => surface.type(el, opts.memberId, true),
    { kind: 'type', value: { kind: 'const', value: opts.memberId }, clearFirst: true });

  await step('Submit the member search',
    o => find(o, e => e.role === 'button' && /search|find member/i.test(e.name), 'search button'),
    el => surface.click(el), { kind: 'click' });

  await step('Open the matching member record from the results',
    o => find(o, e => e.role === 'link' && e.text === 'View', 'View link'),
    el => surface.click(el), { kind: 'click' });

  await step('Open the new sub-account form for this member',
    o => find(o, e => e.role === 'link' && /open sub-account/i.test(e.text ?? ''), 'Open Sub-Account link'),
    el => surface.click(el), { kind: 'click' });

  await step('Choose the sub-account product type',
    o => find(o, e => e.role === 'combobox', 'account type dropdown'),
    el => surface.select(el, opts.accountType),
    { kind: 'select', value: { kind: 'const', value: opts.accountType } });

  await step('Enter the opening deposit amount',
    o => find(o, e => e.role === 'textbox' && /opening deposit/i.test(e.proximityLabel ?? ''), 'deposit field'),
    el => surface.type(el, opts.deposit, true),
    { kind: 'type', value: { kind: 'const', value: opts.deposit }, clearFirst: true });

  await step('Submit the sub-account opening',
    o => find(o, e => e.role === 'button' && /open account/i.test(e.name), 'Open Account button'),
    el => surface.click(el), { kind: 'click' });

  await step('Read the confirmation number from the confirmation screen',
    o => find(o, e => e.role === 'cell' && /confirmation number/i.test(e.proximityLabel ?? ''), 'confirmation number cell'),
    async () => {}, { kind: 'extract', extracts: [{ name: 'confirmation_number', from: 'text', transform: 'trim' }] });

  await browser.close();

  return {
    goal: `Open a ${opts.accountType} sub-account for member ${opts.memberId} and reach the confirmation screen`,
    model: 'fixture/scripted',
    capability: {
      id: 'member.open_sub_account',
      name: 'Open member sub-account',
      description: 'Open a new savings sub-account for an existing member and return the confirmation number. The final step submits the account opening, which cannot be undone from within the application.',
    },
    inputs: [
      { name: 'memberId', type: 'string', required: true, description: 'The member identifier to open the sub-account for.', sensitivity: 'internal', pattern: '^\\d{4,10}$', example: opts.memberId },
      { name: 'accountType', type: 'string', required: true, description: 'Sub-account product type, exactly as listed in the product dropdown.', sensitivity: 'public', example: opts.accountType },
      { name: 'openingDeposit', type: 'string', required: true, description: 'Opening deposit amount. The product enforces a $25.00 minimum.', sensitivity: 'internal', example: opts.deposit },
    ],
    outputs: [
      { name: 'confirmation_number', type: 'string', required: true, description: 'Confirmation reference for the opened sub-account.', sensitivity: 'regulated' },
    ],
    actions,
    declaredOutcomes: [
      { code: 'DEPOSIT_BELOW_MINIMUM', description: 'The opening deposit is below the product minimum, so no account was opened.', whenTextPresent: 'Validation error' },
      { code: 'MEMBER_NOT_FOUND', description: 'No member record matches the supplied identifier.', whenTextPresent: 'No member found' },
    ],
    successText: 'Sub-account opened successfully',
    summary: 'Scripted fixture recording of the sub-account opening flow.',
    turns: 0,
    stopReason: 'goal_reached',
  };
}


if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFixtures(process.env.BASE_URL ?? 'http://localhost:5173/t/tenant-a');
}
