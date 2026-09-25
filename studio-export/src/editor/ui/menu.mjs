// A small popup menu at a screen point: role=menu with menuitem buttons, arrow keys / Home / End to move, Enter or Space to choose,
// Escape or a click elsewhere to close, and focus goes back to where it was. Items: { label, hint?, disabled?, run } | { heading } | { separator: true }.
import { h } from './dom.mjs';

let current = null;

export function closeMenu() { if (current) current.close(); }

export function openMenu({ x, y, label, items }) {
  closeMenu();
  const back = document.activeElement;
  const buttons = [];
  const box = h('div', { class: 'menu', role: 'menu', 'aria-label': label });
  for (const it of items) {
    if (it.separator) { box.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.heading) { box.append(h('div', { class: 'menu-head', role: 'presentation' }, it.heading)); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: 'menu-item', tabindex: '-1', disabled: it.disabled === true }, h('span', {}, it.label), it.hint ? h('kbd', {}, it.hint) : null);
    b.addEventListener('click', () => { close(); it.run(); });
    buttons.push(b);
    box.append(b);
  }
  const live = () => buttons.filter((b) => !b.disabled);
  function close() {
    if (current !== api) return;
    current = null;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    box.remove();
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation(); // no editor shortcut (S = split, Delete...) may fire while a menu has focus
    const list = live();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); } else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); } else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); } else if (e.key === 'Tab') { e.preventDefault(); close(); }
  });
  document.body.append(box);
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('resize', close);
  const api = { close };
  current = api;
  live()[0]?.focus({ preventScroll: true });
  return api;
}
