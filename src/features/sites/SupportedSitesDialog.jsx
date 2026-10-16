import React, { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, X, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { searchSites, verdictOf } from './siteSearchPolicy.js';

export default function SupportedSitesDialog({ sites, error, onRetry, onClose }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { listed, shown, matches, working } = useMemo(() => searchSites(sites, q), [sites, q]);
  const verdict = verdictOf(matches);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="אתרים נתמכים">
        <div className="modal-head">
          <div>
            <h2>אתרים נתמכים</h2>
            <p className="row-meta">{sites ? `${working.toLocaleString('he-IL')} אתרים עובדים כרגע, מתוך ${listed.length.toLocaleString('he-IL')} ברשימה` : 'טוען…'}</p>
          </div>
          <button className="icon-btn" title="סגור" onClick={onClose}><X size={18} /></button>
        </div>
        <label className="search">
          <Search size={17} />
          <input autoFocus placeholder="שם אתר או קישור, למשל dailymotion או https://vimeo.com/…" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />
        </label>

        {q.trim() && sites && (
          verdict === 'ok'
            ? <div className="verdict ok"><CheckCircle2 size={18} /> נתמך. אפשר להדביק את הקישור ולנסות.</div>
            : verdict === 'broken'
              ? <div className="verdict warn"><AlertTriangle size={18} /> האתר ברשימה, אבל התמיכה בו לא עובדת כרגע.</div>
              : <div className="verdict no"><XCircle size={18} /> לא ברשימה. אם הסרטון באתר מוטמע מנגן נתמך (כמו YouTube או Vimeo) זה עדיין עשוי לעבוד. אתרים עם הגנת DRM לא נתמכים.</div>
        )}

        {sites && (
          <div className="sites-count">
            {q.trim() ? `${shown.length.toLocaleString('he-IL')} תוצאות` : `כל האתרים · ${listed.length.toLocaleString('he-IL')}`}
          </div>
        )}
        {!sites && !error && <div className="empty"><RefreshCw size={24} className="spin" /><div>טוען את רשימת האתרים…</div></div>}
        {!sites && error && (
          <div className="empty">
            <AlertTriangle size={24} />
            <div>לא הצלחתי לטעון את רשימת האתרים. אם החלון של Grab היה פתוח לפני עדכון, סגור ופתח אותו מחדש.</div>
            <button className="btn-ghost" onClick={onRetry}><RefreshCw size={16} /> נסה שוב</button>
          </div>
        )}

        <div className="sites-grid">
          {shown.map((s) => (
            <div key={s.name} className={`site-row ${s.broken ? 'broken' : ''}`}>
              <span dir="ltr">{s.name}</span>
              {s.broken && <span className="tag-broken">לא עובד כרגע</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
