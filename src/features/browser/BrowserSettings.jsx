import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Copy, FolderOpen, CheckCircle2, AlertTriangle, XCircle, Trash2, Plus } from 'lucide-react';
import GlassSelect from '../../design/GlassSelect.jsx';

import { api } from '../../platform/grabApi.js';

const PROBLEM_TEXT = {
  not_registered: 'ההתקנה עוד לא בוצעה',
  manifest_missing: 'קבצי החיבור חסרים. לחץ "תיקון"',
  manifest_invalid: 'קבצי החיבור פגומים. לחץ "תיקון"',
  host_missing: 'רכיב החיבור חסר. לחץ "תיקון"',
  host_script_missing: 'קבצי רכיב החיבור חסרים. לחץ "תיקון"',
  id_mismatch: 'מזהה ההרחבה לא תואם. לחץ "תיקון"',
  bad_origin: 'הגדרת ההרשאה לא תקינה. לחץ "תיקון"',
  runtime_missing: 'קובץ ההפעלה של Grab הועבר. לחץ "תיקון"',
  stale_version: 'גרסה ישנה של החיבור. לחץ "תיקון"',
  extension_folder_missing: 'תיקיית ההרחבה נמחקה. לחץ "תיקון" והטען אותה מחדש בדפדפן',
  extension_outdated: 'הדפדפן מריץ הרחבה ישנה. לחץ תיקון ואז Reload בדף ההרחבות',
};
const FAILURE_TEXT = {
  protocol_version: 'גרסת ההרחבה לא תואמת ל-Grab. אחרי "תיקון" טען מחדש את ההרחבה בדפדפן',
  origin_mismatch: 'הדפדפן הציג מזהה הרחבה שונה. לחץ "תיקון" והטען את ההרחבה מהתיקייה שמוצגת למטה',
};
const SOURCE_TEXT = { explicit: 'בחירה להורדה זו', 'site-rule': 'כלל לאתר', global: 'ברירת המחדל שלך', suggested: 'המלצה' };
const TEST_TEXT = {
  notSetUp: 'ההתקנה עוד לא בוצעה. לחץ "התקנה" ואז הטען את ההרחבה בדפדפן.',
  browserUnavailable: 'הדפדפן הזה לא מותקן במחשב.',
  extensionNotConnected: 'ההרחבה לא ענתה. ודא שהיא מותקנת ומופעלת בדפדפן (בפרופיל שבו אתה מחובר).',
  hostSetupError: 'יש בעיית התקנה או גרסת הרחבה ישנה. לחץ "תיקון" ואז Reload בדף ההרחבות.',
  wrongProfile: 'הפרופיל שבחרת לא מחובר כרגע.',
  choiceRequired: 'כמה פרופילים מחוברים. בחר למטה את זה שבו אתה מחובר לאתרים.',
  cancelled: 'הבדיקה בוטלה.',
};
const EXT_URL = { edge: 'edge://extensions', chrome: 'chrome://extensions', brave: 'brave://extensions' };

function StatePill({ b }) {
  if (!b.detected) return <span className="pill pill-muted">לא מותקן</span>;
  if (b.state === 'connected') return <span className="pill pill-success"><CheckCircle2 size={14} /> מחובר</span>;
  if (b.state === 'setup_problem') return <span className="pill pill-danger"><AlertTriangle size={14} /> בעיית התקנה</span>;
  return <span className="pill pill-muted">לא מחובר כרגע</span>;
}

export default function BrowserSettings() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [results, setResults] = useState({});
  const [rule, setRule] = useState({ host: '', browser: 'edge' });
  const [ruleError, setRuleError] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(() => api?.browserState?.().then(setState).catch(() => setState({ unavailable: true, error: 'לא ניתן לקרוא את מצב החיבור לדפדפן. נסה שוב.' })), []);
  useEffect(() => {
    load();
    const off = api?.onBrowserChanged?.(load);
    return () => off?.();
  }, [load]);

  if (!api?.browserState) return null;
  if (!state) return <section className="card settings"><div className="setting"><div className="setting-title">דפדפן והרחבה</div><div className="row-meta">טוען…</div></div></section>;
  if (state.unavailable) return <section className="card settings"><div className="setting"><div><div className="setting-title">דפדפן והרחבה</div><div className="row-meta">{state.error || 'החיבור לדפדפן עדיין לא זמין.'}</div></div><button className="btn-ghost" onClick={load}><RefreshCw size={16} /> נסה שוב</button></div></section>;

  const act = async (name, fn) => { setBusy(name); try { await fn(); } finally { setBusy(''); load(); } };
  const refresh = () => act('refresh', () => api.browserRefresh().then((s) => setState(s)));
  const install = (id) => act('setup:' + id, async () => {
    const r = await api.browserSetup({ browsers: [id] });
    setResults((x) => ({ ...x, [id]: r.ok ? { ok: true, text: 'החיבור הותקן. עכשיו טען את ההרחבה בדפדפן (ראה את השלבים למטה) ולחץ "בדוק חיבור".' } : { ok: false, text: 'ההתקנה נכשלה: ' + (r.error || r.kind) } }));
  });
  const test = (id) => act('test:' + id, async () => {
    const r = await api.browserTest(id);
    let text = r.ok ? `מחובר (${r.instance?.label || ''}) · תגובה תוך ${r.latencyMs} מ״ש` : (TEST_TEXT[r.kind] || 'אי אפשר להתחבר.');
    if (!r.ok && r.kind === 'notSetUp' && r.problems?.length) text += ' ' + (PROBLEM_TEXT[r.problems[0]] || '');
    setResults((x) => ({ ...x, [id]: { ok: !!r.ok, text } }));
  });
  const uninstall = () => act('uninstall', async () => {
    if (!window.confirm('להסיר את החיבור של Grab לדפדפנים? לאחר מכן הסר את התוסף מדף ההרחבות בכל דפדפן.')) return;
    const r = await api.browserUninstall();
    if (r.busy) setResults((x) => ({ ...x, chrome: { ok: false, text: 'סיים או השהה את הפעולות הפעילות לפני הסרת החיבור.' } }));
  });
  const save = (patch) => api.browserSet(patch).then((s) => { setState(s); setRuleError(''); });
  const copy = (text, tag) => navigator.clipboard.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(''), 1800); }).catch(() => {});

  const s = state.settings;
  const detected = state.browsers.filter((b) => b.detected);
  const needsSteps = detected.some((b) => b.state !== 'connected');
  const effective = state.browsers.find((b) => b.id === state.effectiveDefault.browserId);
  const addRule = () => {
    const host = rule.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) { setRuleError('כתוב שם אתר תקין, למשל mako.co.il'); return; }
    save({ siteRules: [...s.siteRules.filter((r) => r.host !== host), { host, browser: rule.browser }] });
    setRule({ host: '', browser: rule.browser });
  };

  return (
    <section className="card settings browser-settings">
      <div className="setting">
        <div>
          <div className="setting-title">דפדפן והרחבה</div>
          <div className="row-meta">Grab משתמש בדפדפן שבו אתה כבר מחובר כדי לזהות סרטונים באתרים שדורשים התחברות. נדרשת התקנה חד־פעמית של ההרחבה בכל דפדפן ופרופיל.</div>
        </div>
        <button className="btn-ghost" onClick={refresh} disabled={busy === 'refresh'}>
          <RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''} /> רענן
        </button>
      </div>

      {!state.supported && <div className="verdict warn"><AlertTriangle size={18} /> חיבור לדפדפן זמין כרגע ב־Windows בלבד.</div>}
      {state.startError && <div className="verdict no"><XCircle size={18} /> הגשר לדפדפן לא עלה: {state.startError}</div>}

      {state.browsers.map((b) => (
        <div className="browser-card" key={b.id}>
          <div className="browser-head">
            <strong>{b.name}</strong>
            <StatePill b={b} />
            {b.systemDefault && <span className="row-meta">ברירת המחדל של Windows</span>}
            <span className="spacer" />
            {b.detected && (<>
              <button className="btn-ghost small" onClick={() => install(b.id)} disabled={!!busy}>
                {busy === 'setup:' + b.id ? <Loader2 size={14} className="spin" /> : null} {b.problems.includes('not_registered') ? 'התקנה' : 'תיקון'}
              </button>
              <button className="btn-ghost small" onClick={() => test(b.id)} disabled={!!busy}>
                {busy === 'test:' + b.id ? <Loader2 size={14} className="spin" /> : null} בדוק חיבור
              </button>
            </>)}
          </div>
          {b.detected && b.state === 'setup_problem' && (
            <div className="row-meta tag-muted">
              {[...b.problems.filter((p) => p !== 'not_registered').map((p) => PROBLEM_TEXT[p]), FAILURE_TEXT[b.failure]].filter(Boolean).join(' · ')}
            </div>
          )}
          {b.instances.map((i) => (
            <div className="instance-row" key={i.key}>
              <input
                defaultValue={i.label}
                maxLength={40}
                aria-label="שם הפרופיל"
                onBlur={(e) => e.target.value.trim() !== i.label && save({ instanceAliases: { [i.key]: e.target.value.trim() } })}
              />
              <label className="row-meta">
                <input type="radio" name={'inst-' + b.id} checked={s.instanceChoice[b.id] === i.key || (b.instances.length === 1 && !s.instanceChoice[b.id])}
                  onChange={() => save({ instanceChoice: { [b.id]: i.key } })} /> הפרופיל שבו אני מחובר
              </label>
            </div>
          ))}
          {b.instances.length > 1 && !s.instanceChoice[b.id] && <div className="row-meta tag-muted">מחוברים כמה פרופילים. בחר את זה שבו אתה מחובר לאתרים, כדי ש-Grab לא ינחש.</div>}
          {results[b.id] && <div className={`verdict ${results[b.id].ok ? 'ok' : 'warn'}`}>{results[b.id].ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {results[b.id].text}</div>}
        </div>
      ))}

      <div className="setting">
        <div>
          <div className="setting-title">דפדפן ברירת מחדל להורדות מבוססות דפדפן</div>
          <div className="row-meta">בשימוש כשאין כלל לאתר ולא נבחר דפדפן להורדה. כרגע: {effective?.name || 'לא זוהה דפדפן'} ({SOURCE_TEXT[state.effectiveDefault.source] || '—'})</div>
        </div>
        <GlassSelect className="plain-select" value={s.defaultBrowser || ''} onChange={(e) => save({ defaultBrowser: e.target.value || null })}>
          <option value="">המלצה אוטומטית</option>
          {detected.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </GlassSelect>
      </div>

      <div className="setting rules">
        <div>
          <div className="setting-title">כללים לפי אתר</div>
          <div className="row-meta">אתר שמופיע כאן ייפתח תמיד בדפדפן שנבחר (גם דומיינים משנה, לא אתרים דומים בשם).</div>
          {s.siteRules.map((r) => (
            <div className="rule-row" key={r.host}>
              <code dir="ltr">{r.host}</code>
              <span>←</span>
              <strong>{state.browsers.find((b) => b.id === r.browser)?.name}</strong>
              <button className="icon-btn" title="הסר כלל" onClick={() => save({ siteRules: s.siteRules.filter((x) => x.host !== r.host) })}><Trash2 size={16} /></button>
            </div>
          ))}
          {!s.siteRules.length && <div className="row-meta">אין כללים.</div>}
          <div className="rule-row add">
            <input dir="ltr" placeholder="mako.co.il" value={rule.host} onChange={(e) => setRule({ ...rule, host: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addRule()} />
            <GlassSelect className="plain-select" value={rule.browser} onChange={(e) => setRule({ ...rule, browser: e.target.value })}>
              {state.browsers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </GlassSelect>
            <button className="btn-ghost small" onClick={addRule}><Plus size={14} /> הוסף</button>
          </div>
          {ruleError && <div className="row-meta tag-muted">{ruleError}</div>}
        </div>
      </div>

      {needsSteps && (
        <div className="setting steps">
          <div>
            <div className="setting-title">טעינת ההרחבה בדפדפן (פעם אחת)</div>
            <ol className="guide-steps">
              <li>לחץ "התקנה" ליד הדפדפן למעלה.</li>
              <li>
                פתח בדפדפן את דף ההרחבות והפעל "מצב מפתח" (Developer mode):
                <span className="guide-address">
                  {detected.map((b) => (
                    <button key={b.id} className="btn-ghost small" onClick={() => copy(EXT_URL[b.id], 'url' + b.id)}><Copy size={13} /> {copied === 'url' + b.id ? 'הועתק' : EXT_URL[b.id]}</button>
                  ))}
                </span>
              </li>
              <li>
                לחץ "Load unpacked" (טען הרחבה לא ארוזה) ובחר את התיקייה הזו:
                <span className="guide-address">
                  <code dir="ltr">{state.extensionDir || '…'}</code>
                  <button className="btn-ghost small" onClick={() => copy(state.extensionDir, 'dir')}><Copy size={13} /> {copied === 'dir' ? 'הועתק' : 'העתק'}</button>
                  <button className="btn-ghost small" onClick={() => api.openExtensionFolder()}><FolderOpen size={13} /> פתח</button>
                </span>
              </li>
              <li>חזור לכאן ולחץ "בדוק חיבור". אל תמחק את התיקייה: בלעדיה ההרחבה תפסיק לעבוד.</li>
            </ol>
          </div>
        </div>
      )}

      {state.installed && <div className="setting"><div className="row-meta">אפשר להסיר את רכיב החיבור; את התוסף מסירים בנפרד בדף ההרחבות.</div><button className="btn-ghost small" onClick={uninstall} disabled={!!busy}><Trash2 size={14} /> הסר חיבור</button></div>}
      <details className="setting advanced">
        <summary>הגדרות זמן (מתקדם)</summary>
        <div className="advanced-grid">
          <label>זמן להתחבר לדפדפן (שניות)
            <input type="number" min="2" max="60" defaultValue={Math.round(s.connectMs / 1000)} onBlur={(e) => save({ connectMs: Number(e.target.value) * 1000 })} />
          </label>
          <label>זמן מקסימלי לזיהוי הסרטון (שניות)
            <input type="number" min="10" max="300" defaultValue={Math.round(s.discoveryMs / 1000)} onBlur={(e) => save({ discoveryMs: Number(e.target.value) * 1000 })} />
          </label>
        </div>
      </details>
    </section>
  );
}
