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
    api?.browserResolve?.(url, value || undefined).then((r) => { if (active) setChoice(r); }).catch(() => {});
    return () => { active = false; };
  }, [url, value, state]);
  if (!state || state.unavailable) return null;
  return <div className="browser-row">
    <label>דפדפן לזיהוי הסרטון</label>
    <GlassSelect className="plain-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">אוטומטי לפי ההגדרות</option>
      {state.browsers.filter((b) => b.detected).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </GlassSelect>
    {choice?.browserId && <span className="row-meta">{choice.name} · {SOURCE[choice.source]}{choice.available ? '' : ' · לא מותקן'}</span>}
  </div>;
}
