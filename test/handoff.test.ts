import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { watchHumanActions } from '../src/escalation/humanWatch.js';

/**
 * The handoff demo hands a session to a person; this is the test that the person's
 * actions actually reach the evidence stream. A simulated human drives the real portal —
 * across the child frame and across a navigation, which are the two places a naive
 * listener silently goes deaf.
 */
const PORT = 5197;
const HOST = `http://localhost:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
  app = spawn('npx', ['tsx', 'app/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(HOST); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  app?.kill();
});

const settle = (page: Page) => page.waitForTimeout(300);

describe('capturing the human\'s actions during a handoff', () => {
  it('records clicks, edits and submits — in the top document, inside a child frame, and after navigation', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${HOST}/t/tenant-a/`);

    const events: Array<{ kind: string; detail: string }> = [];
    const stop = await watchHumanActions(page, (kind, detail) => events.push({ kind, detail }));

    // Top document: the operator signs on. Clicking the submit fires click then submit.
    await page.click('input[type=submit]');
    await page.waitForLoadState('domcontentloaded');
    await settle(page);
    expect(events.map(e => e.kind)).toEqual(expect.arrayContaining(['click', 'submit']));
    expect(events.find(e => e.kind === 'click')?.detail).toBe('input[submit] "Sign On"');

    // Post-navigation, inside the content frame: listeners must have re-attached.
    const before = events.length;
    const content = page.frame({ name: 'content' })!;
    await content.fill('input[name=memberId]', '12345');
    await content.press('input[name=memberId]', 'Tab');       // commit the edit → change
    await content.click('input[type=submit]');
    await content.waitForLoadState('domcontentloaded');
    await settle(page);
    const inFrame = events.slice(before);
    expect(inFrame.map(e => e.kind)).toEqual(expect.arrayContaining(['change', 'click', 'submit']));
    expect(inFrame.find(e => e.kind === 'change')?.detail).toBe('input[text] "12345"');
    expect(inFrame.find(e => e.kind === 'click')?.detail).toBe('input[submit] "Search"');

    // The frame navigated again (results screen): a click there must still be seen.
    const beforeView = events.length;
    await content.click('text=View');
    await content.waitForLoadState('domcontentloaded');
    await settle(page);
    expect(events.slice(beforeView).some(e => e.kind === 'click' && e.detail === 'a "View"')).toBe(true);

    // Handing control back stops delivery; the page keeps working, the log stops growing.
    await stop();
    const afterStop = events.length;
    await content.click('text=New Search');
    await content.waitForLoadState('domcontentloaded');
    await settle(page);
    expect(events.length).toBe(afterStop);

    await context.close();
  }, 60_000);

  it('routes to the newest watcher when the same session is handed over twice', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${HOST}/t/tenant-a/`);

    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = await watchHumanActions(page, k => first.push(k));
    await stopFirst();
    await watchHumanActions(page, k => second.push(k));

    await page.click('input[type=submit]');
    await page.waitForLoadState('domcontentloaded');
    await settle(page);

    expect(first).toEqual([]);
    expect(second).toContain('click');
    await context.close();
  }, 60_000);
});
