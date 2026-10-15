// A drop-in replacement for <select> whose list is part of the app instead of the Windows one: a
// frosted glass menu that opens from the field with a small spring, marks the current choice with a
// check, and highlights options with the same liquid glass drop as the rest of the app (it flows
// between options as the mouse or the arrow keys move). Takes the same props as <select> (value,
// onChange, disabled, className, aria-label, <option> children) and calls onChange with an
// event-like { target: { value } }, so the code around it stays as it was.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

const textOf = (c) => React.Children.toArray(c).map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : textOf(x?.props?.children))).join('');

function optionsOf(children) {
  const out = [];
  React.Children.forEach(children, (c) => {
    if (!c || c.type !== 'option') return;
    const label = textOf(c.props.children);
    out.push({ value: String(c.props.value ?? label), label, disabled: !!c.props.disabled });
  });
  return out;
}

const GAP = 6;
const MARGIN = 10;

export default function GlassSelect({ value, onChange, disabled, className = '', children, ...rest }) {
  const options = useMemo(() => optionsOf(children), [children]);
  const current = options.findIndex((o) => o.value === String(value ?? ''));
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [hl, setHl] = useState(-1);
  const [pos, setPos] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const typed = useRef({ text: '', at: 0 });

  const close = () => {
    if (!open || closing) return;
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); setPos(null); }, 120);
  };
  const show = () => {
    if (disabled || !options.length) return;
    setHl(current >= 0 ? current : options.findIndex((o) => !o.disabled));
    setOpen(true);
  };
  const pick = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (i !== current) onChange?.({ target: { value: o.value } });
    close();
  };
  const step = (from, dir) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
    return from;
  };

  // The whole field the menu belongs to (a label around the button, when there is one).
  const field = () => trigger.current?.closest('.select, .group-chip') || trigger.current;

  // Where the menu goes: under the field (above it when there is more room there)...
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = field().getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < 220 && above > below;
    setPos({
      up,
      minWidth: r.width,
      maxHeight: Math.max(120, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  }, [open]);

  // ...lined up with the field's starting edge, and kept inside the window. Measured once the menu
  // exists (before it is painted), since its width depends on the options.
  useLayoutEffect(() => {
    const m = menu.current;
    if (!pos || !m || !trigger.current) return;
    const r = field().getBoundingClientRect();
    const w = m.offsetWidth;
    const rtl = getComputedStyle(trigger.current).direction === 'rtl';
    const left = Math.min(Math.max(MARGIN, rtl ? r.right - w : r.left), window.innerWidth - w - MARGIN);
    m.style.left = `${left}px`;
  }, [pos]);

  // Closes on a click elsewhere, a scroll outside the menu, a resize, or leaving the window.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (!menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) close(); };
    const scrolled = (e) => { if (!menu.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  });

  // The highlighted option stays in view (on opening, and while moving with the keys).
  useEffect(() => {
    if (open && pos && hl >= 0) menu.current?.querySelectorAll('.gm-item')[hl]?.scrollIntoView({ block: 'nearest' });
  }, [hl, open, pos]);

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((i) => step(i, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((i) => step(i, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setHl(step(-1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setHl(step(options.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hl); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close();
    else if (e.key.length === 1) {
      // typing jumps to the option that starts with the typed letters
      const now = Date.now();
      const t = typed.current;
      t.text = (now - t.at < 700 ? t.text : '') + e.key.toLowerCase();
      t.at = now;
      const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(t.text));
      if (i >= 0) setHl(i);
    }
  };

  return (
    <>
      <button
        type="button" ref={trigger} className={`gselect ${className}`} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open && !closing}
        onClick={() => (open ? close() : show())} onKeyDown={onKeyDown} {...rest}
      >
        <span className="gselect-value">{options[current]?.label ?? ''}</span>
        <ChevronDown size={15} className="gselect-chev" aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div
          ref={menu} role="listbox" className={`gmenu ${pos.up ? 'up' : ''} ${closing ? 'closing' : ''}`}
          style={{ top: pos.top, bottom: pos.bottom, minWidth: pos.minWidth, maxHeight: pos.maxHeight }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <div
              key={o.value} role="option" aria-selected={i === current} aria-disabled={o.disabled || undefined}
              className={`gm-item ${i === hl ? 'hl' : ''} ${i === current ? 'sel' : ''} ${o.disabled ? 'off' : ''}`}
              onPointerEnter={() => !o.disabled && setHl(i)} onClick={() => pick(i)}
            >
              <span className="gm-check">{i === current && <Check size={15} strokeWidth={2.6} />}</span>
              <span className="gm-label">{o.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
