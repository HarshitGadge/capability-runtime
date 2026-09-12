/**
 * In-page accessibility scanner.
 *
 * This runs inside each frame and projects the document into the same `UiElement`
 * shape a UIA or AX provider would produce: role, accessible name, value, state and
 * geometry. It computes accessible names the way the platform does (aria-label,
 * aria-labelledby, associated <label>, control value, content) — not by reading
 * selectors.
 *
 * The one addition beyond a strict a11y projection is `proximityLabel`. Legacy portals
 * routinely ship bare inputs whose only label is the text in the adjacent table cell;
 * those controls have no accessible name at all, so a role+name locator cannot see
 * them. Deriving a label from layout is what keeps such controls addressable, and it
 * is a real technique — the same "nearest label" heuristic screen readers fall back on.
 */
export function scanFrame(arg: { offsetX: number; offsetY: number; framePath: string[] }) {
  const { offsetX, offsetY, framePath } = arg;
  const MAX_TEXT = 160;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    return null;
  }

  /** Accessible-name computation, in the platform's precedence order. */
  function nameOf(el: Element, role: string): string {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? '');
      const joined = clean(parts.join(' '));
      if (joined) return joined;
    }
    if (el.id) {
      const lbl = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent) return clean(lbl.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent) return clean(wrapping.textContent);
    if (role === 'button' && el.tagName.toLowerCase() === 'input') return clean(el.getAttribute('value'));
    if (role === 'button' || role === 'link' || role === 'heading') return clean(el.textContent);
    const title = el.getAttribute('title');
    if (title) return clean(title);
    return '';
  }

  /**
   * Label inferred from layout: the nearest preceding cell in the same table row, then
   * the previous sibling's text, then the text immediately before the element.
   */
  function proximityLabelOf(el: Element): string {
    const cell = el.closest('td, th');
    const row = el.closest('tr');
    if (cell && row) {
      const cells = Array.from(row.children);
      const idx = cells.indexOf(cell);
      for (let i = idx - 1; i >= 0; i--) {
        const t = clean(cells[i]?.textContent);
        if (t) return t;
      }
      // First cell in its row: nothing precedes it, so it has no proximity label.
      // Falling back to the parent here would hand back the entire row's text, which
      // reads as a label and matches almost anything — worse than having none.
      return '';
    }
    let prev = el.previousElementSibling;
    while (prev) {
      const t = clean(prev.textContent);
      if (t) return t;
      prev = prev.previousElementSibling;
    }
    return '';
  }

  /** Row text with cell boundaries preserved, so row scoping matches on whole values. */
  function rowTextOf(el: Element): string | undefined {
    const row = el.closest('tr');
    if (!row) return undefined;
    return clean(Array.from(row.children).map(c => clean(c.textContent)).filter(Boolean).join(' | '));
  }

  function regionOf(el: Element): string {
    let node: Element | null = el;
    while (node) {
      const r = node.getAttribute?.('role');
      if (r && ['region', 'main', 'navigation', 'form', 'dialog'].includes(r)) return clean(node.getAttribute('aria-label') ?? r);
      node = node.parentElement;
    }
    const heading = el.ownerDocument.querySelector('h1, h2, h3, .hdr b, title');
    return clean(heading?.textContent ?? el.ownerDocument.title);
  }

  const out: any[] = [];
  const all = Array.from(document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, td, th, h1, h2, h3, h4, [role], [onclick]'));

  for (const el of all) {
    const role = roleOf(el);
    if (!role) continue;
    const rect = el.getBoundingClientRect();
    // Invisible or zero-area elements are not addressable and only add noise.
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;

    const text = clean(el.textContent);
    if (role === 'cell' || role === 'columnheader') {
      // A layout cell with no text carries no information.
      if (!text) continue;
      // Legacy pages nest tables several deep, so most cells are containers whose text
      // is the concatenation of everything inside them. Keeping those would make almost
      // every text lookup ambiguous, so only leaf cells — the ones that actually hold a
      // label or a value — are reported.
      if (el.querySelector('td, th, table, input, select, textarea, a, button')) continue;
    }

    const name = nameOf(el, role);
    const input = el as HTMLInputElement;

    out.push({
      role,
      name,
      value: 'value' in el ? String(input.value ?? '') : undefined,
      proximityLabel: name ? undefined : proximityLabelOf(el),
      placeholder: el.getAttribute('placeholder') ?? undefined,
      text: text || undefined,
      disabled: Boolean((el as any).disabled) || el.getAttribute('aria-disabled') === 'true',
      focusable: ['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio'].includes(role),
      checked: role === 'checkbox' || role === 'radio' ? Boolean(input.checked) : undefined,
      bounds: { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height },
      frame: framePath,
      rowText: rowTextOf(el),
      region: regionOf(el),
    });
  }

  const pageText = (document.body?.innerText ?? '').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 20000);
  return { elements: out, text: pageText, url: location.href, title: document.title };
}
