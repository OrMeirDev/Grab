import React, { useEffect, useState } from 'react';
import GlassSelect from '../../design/GlassSelect.jsx';
import { api } from '../../platform/grabApi.js';

const SOURCE = { explicit: 'בחירה להורדה זו', 'site-rule': 'כלל לאתר', global: 'ברירת המחדל שלך', suggested: 'מומלץ' };
export default function BrowserPicker({ url, value, onChange }) {
  const [state, setState] = useState(null);
  const [choice, setChoice] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => api?.browserState?.().then((s) => { if (active) setState(s); }).catch(() => {});
    load();
    const off = api?.onBrowserChanged?.(load);
    return () => { active = false; off?.(); };
  }, []);
  useEffect(() => {
    let active = true;
    setChoice(null);
    if (value !== 'direct') api?.browserResolve?.(url, value === 'auto' ? undefined : value).then((r) => { if (active) setChoice(r); }).catch(() => {});
    return () => { active = false; };
  }, [url, value, state]);
  return <div className="browser-row">
    <label>דרך ההורדה</label>
    <GlassSelect className="plain-select" aria-label="דרך ההורדה" value={value === 'direct' ? 'direct' : 'browser'} onChange={(e) => onChange(e.target.value === 'direct' ? 'direct' : 'auto')}>
      <option value="direct">הורדה רגילה מקישור</option>
      <option value="browser">בעזרת התוסף והדפדפן</option>
    </GlassSelect>
    {value !== 'direct' && <>
      <GlassSelect className="plain-select" aria-label="דפדפן מחובר" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">דפדפן ברירת המחדל</option>
        {(state?.browsers || []).filter((b) => b.detected).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </GlassSelect>
      {choice?.browserId && <span className="row-meta">{choice.name} · {SOURCE[choice.source]}{choice.available ? '' : ' · לא מותקן'}</span>}
    </>}
    {value === 'direct' && <span className="row-meta">YouTube ואתרים ציבוריים · ללא חיבור לדפדפן. מאקו דרך Edge.</span>}
  </div>;
}
