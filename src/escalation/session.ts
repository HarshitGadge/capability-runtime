import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

export const SESSION_DIR = path.resolve('.session');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

export interface SessionInfo {
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
  headless: boolean;
}

export const readSession = (): SessionInfo | null => {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
};

/**
 * Launch the browser as a process that OUTLIVES the automation run.
 *
 * This is the structural requirement behind human handoff. If the runner owned the
 * browser, "let a human take control of the live session" would be impossible — the
 * window dies with the process that was stuck. Instead the session is started once and
 * every runner *attaches* to it over CDP, so automation can exit, a person can drive
 * the same window, and a later runner can pick the flow back up mid-flow with the
 * cookies, scroll position and half-filled form exactly as they were left.
 */
export async function startSession(opts: { headless: boolean; port: number }): Promise<{ browser: Browser; info: SessionInfo }> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: opts.headless,
    args: [`--remote-debugging-port=${opts.port}`, '--no-first-run', '--no-default-browser-check'],
  });
  const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 900 } }));
  if (context.pages().length === 0) await context.newPage();

  const info: SessionInfo = {
    cdpEndpoint: `http://127.0.0.1:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    headless: opts.headless,
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(info, null, 2));
  return { browser, info };
}

export interface Attachment { browser: Browser; page: Page; ownsBrowser: boolean; }

/**
 * Attach to the shared session if one is running, otherwise launch a throwaway browser.
 *
 * The fallback exists so the demo is a single command. It is also the honest default
 * for production: a capability invoked by an agent with no human anywhere near it has
 * no reason to keep a window open, and only needs a durable session once escalation is
 * a possibility. Runs that auto-launched cannot be handed to a human, and the runner
 * says so rather than pretending otherwise.
 */
export async function attachOrLaunch(opts: { headless: boolean; viewport?: { width: number; height: number } }): Promise<Attachment> {
  const info = readSession();
  if (info) {
    try {
      const browser = await chromium.connectOverCDP(info.cdpEndpoint, { timeout: 5000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize(opts.viewport ?? { width: 1280, height: 900 }).catch(() => {});
      return { browser, page, ownsBrowser: false };
    } catch {
      // Stale session file — fall through and launch our own.
    }
  }
  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
  const page = await context.newPage();
  return { browser, page, ownsBrowser: true };
}

export const sessionIsShared = (): boolean => readSession() !== null;
