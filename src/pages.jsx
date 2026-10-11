import React, { useEffect, useMemo, useState } from 'react';
import {
  FolderOpen, Play, RotateCcw, Trash2, Search, Film, Music, RefreshCw, Folder, History as HistoryIcon,
  X, CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react';

const api = window.grab;

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const isAudio = (name) => /\.(mp3|m4a|opus|wav|flac)$/i.test(name || '');

function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  );
}

function Empty({ icon: Icon, text }) {
  return <div className="empty"><Icon size={28} /><div>{text}</div></div>;
}

export function HistoryPage({ onRequeue }) {
  const [items, setItems] = useState([]);
  const [missing, setMissing] = useState({});
  const [q, setQ] = useState('');

  const load = async () => {
    const list = await api.getHistory();
    setItems(list);
    const flags = {};
    await Promise.all(list.map(async (h, i) => { flags[i] = !(await api.fileExists(h.file)); }));
    setMissing(flags);
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => items
    .map((h, i) => ({ ...h, i }))
    .filter((h) => !q || h.name.toLowerCase().includes(q.toLowerCase())), [items, q]);

  const clear = async () => {
    if (!window.confirm('למחוק את כל ההיסטוריה? הקבצים עצמם לא יימחקו.')) return;
    await api.clearHistory();
    load();
  };

  return (
    <>
      <PageHeader title="היסטוריה" subtitle="כל מה שהורדת, מהחדש לישן.">
        {items.length > 0 && <button className="btn-ghost" onClick={clear}><Trash2 size={16} /> נקה היסטוריה</button>}
      </PageHeader>
      {items.length > 0 && (
        <label className="search"><Search size={17} /><input placeholder="חיפוש לפי שם" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      )}
      <section className="list">
        {items.length === 0 && <Empty icon={HistoryIcon} text="עוד לא הורדת כלום. הורדות שיסתיימו יופיעו כאן." />}
        {shown.map((h) => (
          <div key={h.i} className="row">
            <span className="row-icon">{h.format === 'mp3' ? <Music size={18} /> : <Film size={18} />}</span>
            <div className="row-info">
              <div className="row-name">{h.name}</div>
              <div className="row-meta">
                {[h.site, fmtDate(h.completedAt)].filter(Boolean).join(' · ')}
                {missing[h.i] && <span className="tag-muted"> · הקובץ הועבר או נמחק</span>}
              </div>
            </div>
            <div className="item-actions">
              {!missing[h.i] && <button className="icon-btn" title="נגן" onClick={() => api.openFile(h.file)}><Play size={18} /></button>}
              {!missing[h.i] && <button className="icon-btn" title="הצג בתיקייה" onClick={() => api.showFile(h.file)}><FolderOpen size={18} /></button>}
              <button className="icon-btn" title="הורד שוב" onClick={() => onRequeue(h)}><RotateCcw size={18} /></button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

export function LibraryPage({ folder }) {
  const [files, setFiles] = useState(null);
  const [q, setQ] = useState('');

  const load = () => { setFiles(null); api.listLibrary(folder).then(setFiles); };
  useEffect(() => { if (folder) load(); }, [folder]);

  const shown = useMemo(() => (files || []).filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())), [files, q]);
  const total = useMemo(() => (files || []).reduce((s, f) => s + f.size, 0), [files]);

  return (
    <>
      <PageHeader title="ספרייה" subtitle={`הקבצים בתיקיית ההורדות${files ? ` · ${files.length} קבצים · ${fmtSize(total)}` : ''}`}>
        <button className="btn-ghost" onClick={load}><RefreshCw size={16} /> רענן</button>
        <button className="btn-ghost" onClick={() => api.openFolder(folder)}><Folder size={16} /> פתח תיקייה</button>
      </PageHeader>
      {files?.length > 0 && (
        <label className="search"><Search size={17} /><input placeholder="חיפוש לפי שם" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      )}
      <section className="list">
        {files === null && <div className="empty">טוען…</div>}
        {files?.length === 0 && <Empty icon={Folder} text="אין עדיין קבצים בתיקיית ההורדות." />}
        {shown.map((f) => (
          <div key={f.file} className="row">
            <span className="row-icon">{isAudio(f.name) ? <Music size={18} /> : <Film size={18} />}</span>
            <div className="row-info">
              <div className="row-name">{f.name.replace(/\.[^.]+$/, '')}</div>
              <div className="row-meta">{[f.folder, fmtSize(f.size), fmtDate(f.modified)].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="item-actions">
              <button className="icon-btn" title="נגן" onClick={() => api.openFile(f.file)}><Play size={18} /></button>
              <button className="icon-btn" title="הצג בתיקייה" onClick={() => api.showFile(f.file)}><FolderOpen size={18} /></button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9֐-׿]/g, '');
const SKIP_LABELS = new Set(['www', 'm', 'my', 'app', 'com', 'co', 'il', 'net', 'org', 'io', 'biz', 'info']);

// "https://www.dailymotion.com/video/x" -> ["dailymotion"]; plain text -> [text]
function searchTerms(query) {
  const q = query.trim();
  const host = q.match(/^(?:https?:\/\/)?([^\s/]+\.[a-z]{2,})(?:[/?#]|$)/i);
  if (!host) return [norm(q)].filter(Boolean);
  return host[1].toLowerCase().split('.').filter((p) => p.length >= 3 && !SKIP_LABELS.has(p)).map(norm);
}

export function SitesModal({ sites, error, onRetry, onClose }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const terms = useMemo(() => searchTerms(q), [q]);
  // Adult sites never appear in the list; an exact name or link search only gets the verdict.
  const listed = useMemo(() => (sites || []).filter((s) => !s.adult), [sites]);
  const shown = useMemo(() => {
    if (!terms.length) return listed;
    return listed.filter((s) => terms.some((t) => norm(s.name).includes(t)));
  }, [listed, terms]);
  const exactHidden = useMemo(
    () => (sites || []).filter((s) => s.adult && terms.some((t) => norm(s.name) === t)),
    [sites, terms],
  );
  const matches = [...shown, ...exactHidden];
  const working = listed.filter((s) => !s.broken).length;

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
          matches.some((s) => !s.broken)
            ? <div className="verdict ok"><CheckCircle2 size={18} /> נתמך. אפשר להדביק את הקישור ולנסות.</div>
            : matches.length
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

export function SettingsPage({ settings, onChange, version, engine }) {
  const checking = engine?.state?.status === 'checking';
  const failed = engine?.state?.result && !engine.state.result.ok;
  const choose = async () => {
    const dir = await api.chooseFolder();
    if (dir) onChange({ folder: dir });
  };
  return (
    <>
      <PageHeader title="הגדרות" subtitle="ברירות המחדל לכל הורדה חדשה. נשמרות אוטומטית." />
      <section className="card settings">
        <div className="setting">
          <div><div className="setting-title">תיקיית הורדות</div><div className="row-meta" dir="auto">{settings.folder}</div></div>
          <div className="item-actions">
            <button className="btn-ghost" onClick={() => api.openFolder(settings.folder)}>פתח</button>
            <button className="btn-ghost" onClick={choose}>שנה תיקייה</button>
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">פורמט</div><div className="row-meta">MP4 לווידאו, MP3 לאודיו בלבד</div></div>
          <div className="segmented">
            <button className={settings.format === 'mp4' ? 'on' : ''} onClick={() => onChange({ format: 'mp4' })}><Film size={16} /> MP4</button>
            <button className={settings.format === 'mp3' ? 'on' : ''} onClick={() => onChange({ format: 'mp3' })}><Music size={16} /> MP3</button>
          </div>
        </div>
        <div className="setting">
          <div><div className="setting-title">איכות וידאו</div><div className="row-meta">"הגבוהה ביותר" מעדיפה פורמט שמתנגן בכל מכשיר (בדרך כלל עד 1080p)</div></div>
          <select className="plain-select" value={settings.quality} onChange={(e) => onChange({ quality: e.target.value })}>
            <option value="best">הגבוהה ביותר</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
          </select>
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">מנוע הורדות</div>
            <div className="row-meta">{version ? `yt-dlp ${version}` : 'לא נמצא'}</div>
            {engine?.state && <div className={`row-meta ${failed ? 'tag-muted' : ''}`}>{engine.message}</div>}
            <div className="row-meta">כשאתר משנה משהו וההורדות מפסיקות לעבוד, עדכון המנוע בדרך כלל פותר את זה.</div>
          </div>
          <button className="btn-ghost" onClick={engine?.update} disabled={checking || engine?.busy}
            title={engine?.busy ? 'אפשר לעדכן כשאין הורדה פעילה' : undefined}>
            <RefreshCw size={16} className={checking ? 'spin' : ''} /> {checking ? 'בודק…' : 'בדוק ועדכן'}
          </button>
        </div>
      </section>
    </>
  );
}
