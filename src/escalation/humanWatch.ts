import type { Page } from 'playwright';

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
export async function watchHumanActions(page: Page, onAction: (kind: string, detail: string) => void): Promise<() => Promise<void>> {
  const BINDING = '__capabilityRuntimeHumanAction';

  await page.exposeBinding(BINDING, (_src, payload: { kind: string; detail: string }) => {
    onAction(payload.kind, payload.detail);
  }).catch(() => { /* already exposed on this page */ });

  const attach = `(() => {
    if (window.__crAttached) return; window.__crAttached = true;
    const describe = (el) => {
      if (!el || !el.tagName) return 'unknown';
      const tag = el.tagName.toLowerCase();
      const label = el.value || el.textContent || el.getAttribute?.('aria-label') || '';
      return tag + ' "' + String(label).replace(/\\s+/g, ' ').trim().slice(0, 60) + '"';
    };
    document.addEventListener('click', e => window.${BINDING}({ kind: 'click', detail: describe(e.target) }), true);
    document.addEventListener('change', e => window.${BINDING}({ kind: 'change', detail: describe(e.target) }), true);
    document.addEventListener('submit', e => window.${BINDING}({ kind: 'submit', detail: describe(e.target) }), true);
  })()`;

  await page.addInitScript(attach).catch(() => {});
  for (const frame of page.frames()) await frame.evaluate(attach).catch(() => {});

  const onFrameNav = (frame: any) => { frame.evaluate(attach).catch(() => {}); };
  page.on('framenavigated', onFrameNav);

  const onNav = () => { for (const f of page.frames()) f.evaluate(attach).catch(() => {}); };
  page.on('load', onNav);

  return async () => {
    page.off('framenavigated', onFrameNav);
    page.off('load', onNav);
  };
}
