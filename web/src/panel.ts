import { el } from './hud.ts';

/**
 * A button in the top right corner and the panel it opens. The panel is a popover, so it closes on
 * Escape or a click elsewhere, opening it closes any other, and it leaves the globe free to drag
 * while it's open.
 */
export function cornerPanel(corner: HTMLElement, id: string, title: string, icon: string) {
  const button = el('button', 'tool', corner);
  button.innerHTML = icon;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.setAttribute('popovertarget', id);

  const panel = el('div', `panel ${id}`, corner);
  panel.id = id;
  panel.setAttribute('popover', '');
  const head = el('div', 'head', panel);
  el('span', '', head, title.toUpperCase());
  const close = el('button', 'close', head, '×');
  close.setAttribute('aria-label', 'Close');
  close.setAttribute('popovertarget', id);
  close.setAttribute('popovertargetaction', 'hide');
  return { button, panel };
}
