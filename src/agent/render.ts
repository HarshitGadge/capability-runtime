import type { Observation, UiElement } from '../schema/observation.js';

/**
 * Render an observation for the model.
 *
 * Text, not pixels, is the primary channel: it is an order of magnitude cheaper per
 * turn, it is what the model actually reasons over, and it is the representation a
 * desktop accessibility API would hand us too. Screenshots are attached only when the
 * text view is ambiguous or a step fails, where they earn their tokens.
 *
 * Every string here has already been through the redactor. The model is choosing which
 * control to press; it does not need to see a balance to do that, and the one reliable
 * way to keep regulated values out of a third party is never to send them.
 */
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio']);

export interface RenderedScreen {
  text: string;
  /** ref -> element, valid only for this observation. */
  index: Map<string, UiElement>;
}

export function renderObservation(obs: Observation, maxCells = 40): RenderedScreen {
  const index = new Map<string, UiElement>();
  const lines: string[] = [`URL: ${obs.url}`, `TITLE: ${obs.title}`, ''];

  const byFrame = new Map<string, UiElement[]>();
  for (const el of obs.elements) {
    const key = el.frame.length ? el.frame.join('/') : '(top)';
    byFrame.set(key, [...(byFrame.get(key) ?? []), el]);
  }

  let n = 0;
  for (const [frame, els] of byFrame) {
    const controls = els.filter(e => INTERACTIVE.has(e.role) && !e.disabled);
    const cells = els.filter(e => (e.role === 'cell' || e.role === 'columnheader') && e.text).slice(0, maxCells);
    if (!controls.length && !cells.length) continue;

    lines.push(`FRAME ${frame}`);
    for (const el of controls) {
      const ref = String(++n);
      index.set(ref, el);
      const label = el.name || el.proximityLabel || el.text || '(unlabelled)';
      const value = el.value ? ` value="${el.value}"` : '';
      const row = el.rowText && el.role === 'link' ? ` in-row="${truncate(el.rowText, 70)}"` : '';
      lines.push(`  [${ref}] ${el.role.padEnd(9)} "${truncate(label, 60)}"${value}${row}`);
    }
    for (const el of cells) {
      const ref = String(++n);
      index.set(ref, el);
      const label = el.proximityLabel ? ` label="${truncate(el.proximityLabel, 40)}"` : '';
      lines.push(`  [${ref}] ${'cell'.padEnd(9)} "${truncate(el.text!, 60)}"${label}`);
    }
    const text = obs.textByFrame[frame];
    if (text) lines.push(`  TEXT: ${truncate(text.replace(/\n+/g, ' / '), 700)}`);
    lines.push('');
  }

  return { text: lines.join('\n'), index };
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
