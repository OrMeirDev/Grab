// Liquid glass selection. In every group of choices (the sidebar navigation, the segmented switches,
// the category tabs, the options of an open menu) the selected item sits on one glass drop, and when the choice changes the drop
// flows to it like a balloon: the edge in the direction of travel leaves first, the trailing edge
// catches up a moment later with a little overshoot, and the sides pull in slightly while it is
// stretched. It works on the existing markup and adds no elements: the drop is the group's ::before,
// placed through four CSS variables (see theme.css). The page is watched, so groups that appear later
// (another page, a dialog) get the drop too.
const GROUPS = [
  { box: '.sidebar nav', item: '.nav-item', on: '.active' },
  { box: '.segmented', item: ':scope > button', on: '.on' },
  { box: '.cat-tabs', item: '.cat-tab', on: '.on' },
  { box: '.gmenu', item: '.gm-item', on: '.hl' },
];

const LEAD = '.3s cubic-bezier(.3, .8, .25, 1)';
const TRAIL = '.5s cubic-bezier(.55, 0, .3, 1.4) 40ms';
const SQUEEZE_IN = '.16s ease-out';
const SQUEEZE_OUT = '.46s cubic-bezier(.25, 1.6, .45, 1)';
const SQUEEZE_PX = 3;

const state = new WeakMap(); // group element -> { t, b, l, r, item, timer }
// class changes are what the watcher reacts to, so a class is only touched when it really changes
const toggle = (el, cls, on) => { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); };
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function set(box, edges, timing) {
  const s = box.style;
  for (const k of ['t', 'b', 'l', 'r']) {
    s.setProperty(`--lg-${k}d`, timing ? timing[k] : '0s');
    s.setProperty(`--lg-${k}`, `${edges[k]}px`);
  }
}

function place(box, item) {
  const prev = state.get(box);
  if (!item || !box.offsetWidth || !item.offsetWidth) {
    toggle(box, 'lg-on', false);
    if (prev) prev.gone = true;
    return;
  }
  const hb = box.getBoundingClientRect();
  const ib = item.getBoundingClientRect();
  const x0 = hb.left + box.clientLeft - box.scrollLeft;
  const y0 = hb.top + box.clientTop - box.scrollTop;
  const next = { t: ib.top - y0, b: ib.bottom - y0, l: ib.left - x0, r: ib.right - x0 };
  const same = prev && !prev.gone && prev.item === item && ['t', 'b', 'l', 'r'].every((k) => Math.abs(prev[k] - next[k]) < 0.5);
  if (same) return;
  toggle(box, 'lg-ready', true);
  toggle(box, 'lg-on', true);
  clearTimeout(prev?.timer);
  const moved = prev && !prev.gone && prev.item !== item && !reduced();
  if (!moved) {
    // first placement, a resize or a re-layout: no animation
    set(box, next, null);
    state.set(box, { ...next, item });
    return;
  }
  const dy = (next.t + next.b) / 2 - (prev.t + prev.b) / 2;
  const dx = (next.l + next.r) / 2 - (prev.l + prev.r) / 2;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const timing = vertical
    ? { t: dy < 0 ? LEAD : TRAIL, b: dy > 0 ? LEAD : TRAIL, l: SQUEEZE_IN, r: SQUEEZE_IN }
    : { l: dx < 0 ? LEAD : TRAIL, r: dx > 0 ? LEAD : TRAIL, t: SQUEEZE_IN, b: SQUEEZE_IN };
  // while it travels the drop is a little thinner across the direction of travel...
  const squeezed = vertical
    ? { ...next, l: next.l + SQUEEZE_PX, r: next.r - SQUEEZE_PX }
    : { ...next, t: next.t + SQUEEZE_PX / 1.5, b: next.b - SQUEEZE_PX / 1.5 };
  set(box, squeezed, timing);
  // ...and springs back to full size as the trailing edge arrives
  const timer = setTimeout(() => {
    const back = vertical ? { ...timing, l: SQUEEZE_OUT, r: SQUEEZE_OUT } : { ...timing, t: SQUEEZE_OUT, b: SQUEEZE_OUT };
    set(box, next, back);
  }, 170);
  state.set(box, { ...next, item, timer });
}

function update() {
  for (const g of GROUPS) {
    for (const box of document.querySelectorAll(g.box)) {
      toggle(box, 'lg-host', true);
      const item = [...box.querySelectorAll(g.item)].find((el) => el.matches(g.on));
      place(box, item);
    }
  }
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; update(); });
}

export function startLiquidGlass() {
  // Only class changes and added/removed elements matter; the drop's own style changes are ignored.
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(schedule).observe(document.body);
  window.addEventListener('resize', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
}
