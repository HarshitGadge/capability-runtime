import type { Frame, Page } from 'playwright';
import type { Observation, UiElement } from '../../schema/observation.js';
import { scanFrame } from './scanner.js';

/**
 * A perception provider turns a live page into an `Observation`.
 *
 * There are two implementations, and the reason is architectural rather than defensive.
 * The system claims that perception is swappable without touching the artifact schema
 * or the replay engine; shipping a second provider is how that claim is tested instead
 * of asserted. `--ax-provider cdp` runs the whole demo through the browser's real
 * accessibility tree; `--ax-provider dom-scan` runs it through an in-page projection.
 * Neither one is visible above `Surface`.
 */
export interface PerceptionProvider {
  readonly id: string;
  observe(page: Page): Promise<Observation>;
}

const AX_ROLES = new Set(['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'cell', 'columnheader', 'heading']);

const NAME_SHIM = 'window.__name = window.__name || (f => f)';

/** Frame position within the top-level viewport, so all geometry lands in one space. */
async function frameOffset(frame: Frame): Promise<{ x: number; y: number; path: string[] }> {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    path.unshift(f.name() || 'frame');
    f = f.parentFrame();
  }
  if (!frame.parentFrame()) return { x: 0, y: 0, path: [] };
  const handle = await frame.frameElement().catch(() => null);
  const box = handle ? await handle.boundingBox().catch(() => null) : null;
  return { x: box?.x ?? 0, y: box?.y ?? 0, path };
}

/**
 * Default provider. Projects each frame's DOM into role/name/value/state/geometry using
 * platform accessible-name rules, plus the proximity-label fallback that legacy pages
 * require. Richer than the raw AX tree on exactly the surfaces this system targets,
 * because it can label controls the AX tree leaves anonymous.
 */
export class DomScanProvider implements PerceptionProvider {
  readonly id = 'web/dom-scan';

  async observe(page: Page): Promise<Observation> {
    const elements: UiElement[] = [];
    const textByFrame: Record<string, string> = {};
    const urlByFrame: Record<string, string> = {};
    const viewport = page.viewportSize() ?? { width: 1280, height: 900 };

    for (const frame of page.frames()) {
      const { x, y, path } = await frameOffset(frame);
      // The bundler names nested functions via a `__name` helper that does not exist in
      // the page; shim it before injecting the scanner.
      await frame.evaluate(NAME_SHIM).catch(() => {});
      const scanned = await frame.evaluate(scanFrame, { offsetX: x, offsetY: y, framePath: path }).catch(() => null);
      if (!scanned) continue;
      const key = path.length ? path.join('/') : '(top)';
      textByFrame[key] = scanned.text;
      urlByFrame[key] = scanned.url;
      for (const [i, e] of (scanned.elements as any[]).entries()) {
        elements.push({ ...e, ref: `${key}#${i}`, disabled: !!e.disabled, focusable: !!e.focusable, frame: path });
      }
    }

    return {
      observedAt: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ''),
      elements,
      textByFrame,
      urlByFrame,
      provider: this.id,
      viewport,
    };
  }
}

/**
 * Alternative provider backed by the browser's real accessibility tree
 * (CDP `Accessibility.getFullAXTree`), with geometry from `DOM.getBoxModel`.
 *
 * This is the closest web analogue to what a desktop automation API hands you: a tree
 * of roles, names and states with no access to markup. It is genuinely weaker here —
 * unlabelled legacy inputs come back nameless and it cannot infer proximity labels —
 * and that weakness is the useful finding, not a defect: it is why the locator cascade
 * has rungs below role+name at all.
 */
export class CdpAxProvider implements PerceptionProvider {
  readonly id = 'web/cdp-ax';

  async observe(page: Page): Promise<Observation> {
    const elements: UiElement[] = [];
    const textByFrame: Record<string, string> = {};
    const urlByFrame: Record<string, string> = {};
    const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
    const client = await page.context().newCDPSession(page);
    let i = 0;

    try {
      await client.send('DOM.getDocument', { depth: -1, pierce: true }).catch(() => {});

      // Same-origin frames share the parent's CDP session, so each one is addressed by
      // frameId rather than by its own session. A frameset portal keeps every screen
      // that matters one frame down, so skipping this would perceive an empty shell.
      const tree = (await client.send('Page.getFrameTree')) as any;
      const cdpFrames: Array<{ id: string; name?: string; url: string }> = [];
      const walk = (node: any) => { cdpFrames.push(node.frame); (node.childFrames ?? []).forEach(walk); };
      walk(tree.frameTree);

      for (const cdpFrame of cdpFrames) {
        const pwFrame = page.frames().find(f => f.url() === cdpFrame.url && (f.name() || '') === (cdpFrame.name ?? ''));
        const { path } = pwFrame ? await frameOffset(pwFrame) : { path: [] as string[] };
        const key = path.length ? path.join('/') : '(top)';
        urlByFrame[key] = cdpFrame.url;
        textByFrame[key] = pwFrame
          ? await pwFrame.evaluate(() => (document.body?.innerText ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, 20000)).catch(() => '') as string
          : '';

        const tree = await client.send('Accessibility.getFullAXTree', { frameId: cdpFrame.id } as any).catch(() => null) as any;
        if (!tree?.nodes) continue;

        for (const n of tree.nodes as any[]) {
          const role = n.role?.value;
          if (!role || n.ignored || !AX_ROLES.has(role) || !n.backendDOMNodeId) continue;

          const box = await client.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId }).catch(() => null) as any;
          const quad = box?.model?.border as number[] | undefined;
          if (!quad) continue;
          const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
          const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
          const x = Math.min(...xs), y = Math.min(...ys);
          const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
          if (width <= 0 || height <= 0) continue;

          const prop = (name: string) => (n.properties ?? []).find((p: any) => p.name === name)?.value?.value;
          const name = n.name?.value ?? '';
          if ((role === 'cell' || role === 'columnheader') && !name) continue;

          elements.push({
            ref: `ax#${i++}`,
            role,
            name,
            value: n.value?.value != null ? String(n.value.value) : undefined,
            text: name || undefined,
            // The gap versus the DOM-scan provider, stated plainly: a raw accessibility
            // tree has no notion of "the label in the cell to the left", so a legacy
            // control with no accessible name arrives anonymous and nothing above the
            // ordinal rung of the cascade can find it. That is a real property of
            // accessibility APIs — the same is true of UIA on a badly built desktop app
            // — and it is the reason the cascade has lower rungs at all.
            proximityLabel: undefined,
            disabled: prop('disabled') === true,
            focusable: prop('focusable') === true,
            checked: typeof prop('checked') === 'boolean' ? prop('checked') : undefined,
            // Verified against Playwright's own element geometry: for same-process
            // frames CDP reports box-model quads already in main-frame coordinates, so
            // unlike the in-page scanner (whose getBoundingClientRect is frame-local)
            // this provider must not add the frame offset. Both therefore hand the rest
            // of the system geometry in one coordinate space, which is what `Surface`
            // promises its callers.
            bounds: { x, y, width, height },
            frame: path,
          });
        }
      }
    } finally {
      await client.detach().catch(() => {});
    }

    return {
      observedAt: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ''),
      elements,
      textByFrame,
      urlByFrame,
      provider: this.id,
      viewport,
    };
  }
}

export function providerFor(id: string): PerceptionProvider {
  if (id === 'cdp' || id === 'web/cdp-ax') return new CdpAxProvider();
  return new DomScanProvider();
}
