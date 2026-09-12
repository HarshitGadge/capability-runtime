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

interface AxNode {
  nodeId: string; parentId?: string; childIds?: string[]; ignored?: boolean; backendDOMNodeId?: number;
  role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; properties?: any[];
}

/** Roles whose presence inside a cell marks it as a container rather than a value. */
const CONTAINER_ROLES = new Set(['cell', 'columnheader', 'table', 'textbox', 'combobox', 'button', 'link']);

/**
 * Structural queries over one frame's accessibility tree.
 *
 * Chrome names layout tables `LayoutTable`/`LayoutTableRow`/`LayoutTableCell` and data
 * tables `table`/`row`/`cell`; legacy portals use both, often nested, so the two
 * vocabularies are folded together before anything reasons about rows.
 */
class AxIndex {
  private readonly byId = new Map<string, AxNode>();
  constructor(nodes: AxNode[]) { for (const n of nodes) this.byId.set(n.nodeId, n); }

  role(n: AxNode): string | undefined {
    const r = n.role?.value;
    if (!r) return undefined;
    if (r === 'LayoutTableCell' || r === 'gridcell') return 'cell';
    if (r === 'LayoutTableRow') return 'row';
    if (r === 'LayoutTable') return 'table';
    return r;
  }
  name(n: AxNode): string { return (n.name?.value ?? '').replace(/\s+/g, ' ').trim(); }

  private parent(n: AxNode): AxNode | undefined { return n.parentId ? this.byId.get(n.parentId) : undefined; }
  private ancestor(n: AxNode, role: string): AxNode | undefined {
    for (let p = this.parent(n); p; p = this.parent(p)) if (this.role(p) === role) return p;
    return undefined;
  }
  private children(n: AxNode): AxNode[] { return (n.childIds ?? []).map(id => this.byId.get(id)).filter((c): c is AxNode => !!c); }

  hasDescendant(n: AxNode, pred: (d: AxNode) => boolean): boolean {
    return this.children(n).some(c => pred(c) || this.hasDescendant(c, pred));
  }

  /** Visible text under a node, from its leaf names, in document order. */
  private textOf(n: AxNode): string {
    const own = this.name(n);
    const kids = this.children(n).map(c => this.textOf(c)).filter(Boolean).join(' ');
    return (own && !kids ? own : kids || own).replace(/\s+/g, ' ').trim();
  }

  private cellsOfRow(row: AxNode): AxNode[] { return this.children(row).filter(c => this.role(c) === 'cell' || this.role(c) === 'columnheader'); }

  /** Text of the row containing a node, cell by cell — the basis of `row_containing` scoping. */
  rowText(n: AxNode): string | undefined {
    const row = this.role(n) === 'row' ? n : this.ancestor(n, 'row');
    if (!row) return undefined;
    const text = this.cellsOfRow(row).map(c => this.textOf(c)).filter(Boolean).join(' | ');
    return text || undefined;
  }

  /** Text of the nearest preceding cell in the same row — the legacy label heuristic. */
  proximityLabel(n: AxNode): string | undefined {
    const cell = (this.role(n) === 'cell' || this.role(n) === 'columnheader') ? n : this.ancestor(n, 'cell');
    const row = cell && this.ancestor(cell, 'row');
    if (!cell || !row) return undefined;
    const cells = this.cellsOfRow(row);
    for (let i = cells.indexOf(cell) - 1; i >= 0; i--) {
      const t = this.textOf(cells[i]!);
      if (t) return t;
    }
    return undefined;
  }
}

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
      const rootFrameId: string = tree.frameTree.frame.id;

      for (const cdpFrame of cdpFrames) {
        // Join CDP frames to Playwright frames by NAME, not URL. Mid-navigation the two
        // views can disagree on a frame's URL for a moment, and joining on it drops that
        // frame's route from the observation — which made the surface fingerprint look
        // different through this provider when the screens were in fact identical.
        // Frame names are stable across navigation; URL is the fallback only for unnamed
        // subframes, and the root is matched by identity.
        const cdpName = cdpFrame.name ?? '';
        const pwFrame = page.frames().find(f => {
          if (cdpFrame.id === rootFrameId) return !f.parentFrame();
          if (cdpName) return (f.name() || '') === cdpName;
          return !!f.parentFrame() && f.url() === cdpFrame.url;
        });
        const { path } = pwFrame ? await frameOffset(pwFrame) : { path: [] as string[] };
        const key = path.length ? path.join('/') : '(top)';
        urlByFrame[key] = cdpFrame.url;
        textByFrame[key] = pwFrame
          ? await pwFrame.evaluate(() => (document.body?.innerText ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, 20000)).catch(() => '') as string
          : '';

        const tree = await client.send('Accessibility.getFullAXTree', { frameId: cdpFrame.id } as any).catch(() => null) as any;
        if (!tree?.nodes) continue;
        const ax = new AxIndex(tree.nodes as AxNode[]);

        for (const n of tree.nodes as AxNode[]) {
          const role = ax.role(n);
          if (!role || n.ignored || !AX_ROLES.has(role) || !n.backendDOMNodeId) continue;
          // Same rule as the in-page scanner: a cell that contains other cells or controls
          // is layout, not information. Only leaf cells are reported.
          if ((role === 'cell' || role === 'columnheader') && (!ax.name(n) || ax.hasDescendant(n, d => CONTAINER_ROLES.has(ax.role(d) ?? '')))) continue;

          const box = await client.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId }).catch(() => null) as any;
          const quad = box?.model?.border as number[] | undefined;
          if (!quad) continue;
          const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
          const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
          const x = Math.min(...xs), y = Math.min(...ys);
          const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
          if (width <= 0 || height <= 0) continue;

          const prop = (name: string) => (n.properties ?? []).find((p: any) => p.name === name)?.value?.value;
          const name = ax.name(n);

          elements.push({
            ref: `ax#${i++}`,
            role,
            name,
            value: n.value?.value != null ? String(n.value.value) : undefined,
            text: name || undefined,
            // An accessibility tree has no accessible name for a bare legacy input, but it
            // does carry table structure — the same row/cell relationships the in-page
            // scanner walks in the DOM. Deriving "the label in the cell to the left" from
            // AX rows is what UIA's Table/Grid patterns would give a desktop provider, so
            // it belongs here rather than being a DOM-only trick.
            // A cell's accessible name is its own content, so for cells the label beside
            // it is computed regardless — that is what makes a value cell addressable as
            // "the one labelled Savings Balance" rather than by its position.
            proximityLabel: name && role !== 'cell' ? undefined : ax.proximityLabel(n),
            disabled: prop('disabled') === true,
            focusable: prop('focusable') === true,
            checked: typeof prop('checked') === 'boolean' ? prop('checked') : undefined,
            // Verified against Playwright's own element geometry: for same-process frames
            // CDP reports box-model quads already in main-frame coordinates, so unlike
            // the in-page scanner (whose getBoundingClientRect is frame-local) this
            // provider must not add the frame offset.
            bounds: { x, y, width, height },
            frame: path,
            rowText: ax.rowText(n),
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
