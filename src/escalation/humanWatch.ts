import type { Frame, Page } from 'playwright';

/**
 * Capture what the human does while they hold the session.
 *
 * Handing control to a person and learning nothing from it wastes the most informative
 * event the system produces. An operator's intervention is evidence of a gap — a screen
 * the capability could not handle, a decision it was not allowed to make — and it
 * belongs in the same run log as everything the automation did, so the run reads as one
 * continuous story across the handoff rather than two disconnected halves.
 *
 * The listeners are attached to every existing frame and re-attached on navigation, and
 * they are passive: they observe, they never block or alter the interaction.
 */

const BINDING = '__capabilityRuntimeHumanAction';

/**
 * A page can expose a binding only once, but a page can be handed to a human more than
 * once in its life. So the binding is installed once and forwards to whichever handler
 * is current; `stop()` clears it, and a later watch replaces it. Without this, the first
 * watcher would keep receiving events from every subsequent handoff.
 */
const handlers = new WeakMap<Page, ((kind: string, detail: string) => void) | null>();

const ATTACH = `(() => {
  if (window.__crAttached) return; window.__crAttached = true;
  const describe = (el) => {
    if (!el || !el.tagName) return 'unknown';
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute?.('type');
    const label = el.value || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('name') || '';
    return tag + (type ? '[' + type + ']' : '') + ' "' + String(label).replace(/\\s+/g, ' ').trim().slice(0, 60) + '"';
  };
  const send = (kind, target) => { try { window.${BINDING}({ kind, detail: describe(target) }); } catch {} };
  document.addEventListener('click',  e => send('click',  e.target), true);
  document.addEventListener('change', e => send('change', e.target), true);
  document.addEventListener('submit', e => send('submit', e.target), true);
})()`;

export async function watchHumanActions(page: Page, onAction: (kind: string, detail: string) => void): Promise<() => Promise<void>> {
  const first = !handlers.has(page);
  handlers.set(page, onAction);

  if (first) {
    await page.exposeBinding(BINDING, (_src, payload: { kind: string; detail: string }) => {
      handlers.get(page)?.(payload.kind, payload.detail);
    });
    // Future documents, in every frame, get the listeners before their own scripts run.
    await page.addInitScript(ATTACH);
  }
  // Documents that are already loaded need them injected now.
  for (const frame of page.frames()) await frame.evaluate(ATTACH).catch(() => {});

  // Belt and braces for frames whose init script raced the navigation.
  const onFrameNav = (frame: Frame) => { frame.evaluate(ATTACH).catch(() => {}); };
  page.on('framenavigated', onFrameNav);

  return async () => {
    page.off('framenavigated', onFrameNav);
    handlers.set(page, null);
  };
}
