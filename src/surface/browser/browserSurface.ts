import type { Browser, Frame, Page } from 'playwright';
import type { Observation, UiElement } from '../../schema/observation.js';
import type { ElementTarget } from '../../schema/locator.js';
import type { ResolveResult, Surface } from '../surface.js';
import { resolveTarget } from '../locatorResolver.js';
import { providerFor, type PerceptionProvider } from './providers.js';

/**
 * Browser implementation of `Surface`.
 *
 * Two deliberate properties:
 *
 * 1. Elements are *found* semantically and never by selector. Nothing in this file
 *    constructs a CSS or XPath expression, and the locator cascade never sees markup.
 *
 * 2. Elements are *acted on* through the platform's native mechanism, which for a
 *    browser means a real mouse click at the element's coordinates and real key
 *    events. Setting a <select>'s value is the one exception: driving a native
 *    dropdown by coordinate is unreliable in every automation stack, so the provider
 *    uses the element under the point and fires the change event — the direct analogue
 *    of UIA's SelectionItemPattern. The split matters: *finding* must be portable,
 *    *acting* is inherently platform-specific and belongs behind this interface.
 */
export class BrowserSurface implements Surface {
  readonly kind = 'web' as const;

  constructor(
    private readonly browser: Browser,
    readonly page: Page,
    private readonly provider: PerceptionProvider,
    private readonly ownsBrowser: boolean,
  ) {}

  get providerId(): string { return this.provider.id; }

  static async attach(browser: Browser, page: Page, providerId = 'dom-scan', ownsBrowser = false): Promise<BrowserSurface> {
    return new BrowserSurface(browser, page, providerFor(providerId), ownsBrowser);
  }

  async observe(): Promise<Observation> {
    await this.settle();
    return this.provider.observe(this.page);
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: false }).catch(() => Buffer.alloc(0));
  }

  async resolve(target: ElementTarget, obs: Observation, bindings: Record<string, unknown>): Promise<ResolveResult> {
    return resolveTarget(target, obs, bindings);
  }

  async click(el: UiElement): Promise<void> {
    const { x, y } = await this.pointFor(el);
    await this.page.mouse.click(x, y);
    await this.settle();
  }

  async type(el: UiElement, text: string, clearFirst: boolean): Promise<void> {
    const { x, y } = await this.pointFor(el);
    await this.page.mouse.click(x, y);
    if (clearFirst) {
      await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await this.page.keyboard.press('Delete');
    }
    await this.page.keyboard.type(text, { delay: 12 });
  }

  async select(el: UiElement, value: string): Promise<void> {
    const frame = this.frameFor(el);
    const offset = await this.offsetOf(frame);
    const local = { x: el.bounds.x + el.bounds.width / 2 - offset.x, y: el.bounds.y + el.bounds.height / 2 - offset.y };
    const ok = await frame.evaluate(({ p, v }) => {
      const node = document.elementFromPoint(p.x, p.y) as HTMLSelectElement | null;
      const sel = node?.closest?.('select') as HTMLSelectElement | null;
      if (!sel) return false;
      const opt = Array.from(sel.options).find(o => o.text.trim().toLowerCase() === v.trim().toLowerCase() || o.value === v);
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { p: local, v: value });
    if (!ok) throw new Error(`Could not select option "${value}" on ${el.role} "${el.name || el.proximityLabel}"`);
    await this.settle();
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.settle();
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.settle();
  }

  async currentUrl(): Promise<string> { return this.page.url(); }

  /**
   * Release the browser. When this run owns it, that shuts it down; when the run merely
   * attached to a shared session, the same call drops the CDP connection and leaves the
   * window open for the next run — or for a person. Not disconnecting is why an attached
   * run appears to finish and then never exits.
   */
  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }

  /**
   * Wait for the surface to stop moving. `networkidle` is the wrong signal on a portal
   * that polls, so we settle on load state plus a short quiet period — enough to catch
   * a frame navigation without coupling to any particular spinner.
   */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await this.page.waitForTimeout(120);
  }

  private frameFor(el: UiElement): Frame {
    if (!el.frame.length) return this.page.mainFrame();
    const match = this.page.frames().find(f => {
      const path: string[] = [];
      let cur: Frame | null = f;
      while (cur && cur.parentFrame()) { path.unshift(cur.name() || 'frame'); cur = cur.parentFrame(); }
      return path.join('/') === el.frame.join('/');
    });
    return match ?? this.page.mainFrame();
  }

  private async offsetOf(frame: Frame): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    const handle = await frame.frameElement().catch(() => null);
    const box = handle ? await handle.boundingBox().catch(() => null) : null;
    return { x: box?.x ?? 0, y: box?.y ?? 0 };
  }

  /**
   * Centre point of the element, scrolling its frame if the control sits below the
   * fold. Reported as a clear surface error rather than a silent mis-click if the
   * element still cannot be brought into view.
   */
  private async pointFor(el: UiElement): Promise<{ x: number; y: number }> {
    const vp = this.page.viewportSize() ?? { width: 1280, height: 900 };
    let { x, y } = { x: el.bounds.x + el.bounds.width / 2, y: el.bounds.y + el.bounds.height / 2 };
    if (y < 0 || y > vp.height) {
      const frame = this.frameFor(el);
      const offset = await this.offsetOf(frame);
      await frame.evaluate(dy => window.scrollBy(0, dy), y - offset.y - vp.height / 2).catch(() => {});
      await this.page.waitForTimeout(150);
      const fresh = (await this.provider.observe(this.page)).elements
        .find(c => c.role === el.role && c.name === el.name && c.text === el.text && c.frame.join('/') === el.frame.join('/'));
      if (fresh) { x = fresh.bounds.x + fresh.bounds.width / 2; y = fresh.bounds.y + fresh.bounds.height / 2; }
    }
    if (x < 0 || y < 0 || x > vp.width || y > vp.height) {
      throw new Error(`Element "${el.name || el.proximityLabel || el.text}" is outside the viewport at (${Math.round(x)},${Math.round(y)})`);
    }
    return { x, y };
  }
}
