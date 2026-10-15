import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download, History, Folder, Settings, Home, ChevronLeft, ClipboardPaste, Sparkles, Link2,
  ArrowUpDown, GripVertical, FolderOpen, Check, Pause, Play, Clock, RotateCw, Trash2,
  AlertTriangle, Unlink, Video, Music, Settings2, Loader2, RefreshCw,
} from 'lucide-react';
import GlassSelect from './glass-select.jsx';
// The Grab name with its symbol on the right (vector, from the brand package).
import brandLockup from './assets/brand/logo-lockup.svg';

import { siYoutube, siVimeo, siInstagram, siTiktok } from 'simple-icons';
import { HistoryPage, LibraryPage, SettingsPage, SitesModal, SignInGuideModal } from './pages.jsx';

const api = window.grab;

const PAGES = [
  { id: 'downloads', icon: Download, label: 'הורדות' },
  { id: 'history', icon: History, label: 'היסטוריה' },
  { id: 'library', icon: Folder, label: 'ספרייה' },
  { id: 'settings', icon: Settings, label: 'הגדרות' },
];

// Brand marks from Simple Icons (CC0 SVG paths), drawn white on the brand color.
const SITES = [
  { key: 'youtube', name: 'YouTube', color: '#ff0000', icon: siYoutube },
  { key: 'vimeo', name: 'Vimeo', color: '#1ab7ea', icon: siVimeo },
  { key: 'instagram', name: 'Instagram', color: '#ff0069', icon: siInstagram },
  { key: 'tiktok', name: 'TikTok', color: '#000000', icon: siTiktok },
];

const QUALITIES = [
  { value: 'best', label: 'האיכות הגבוהה ביותר' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
];

const ERROR_LABELS = {
  blocked: 'האתר חסם זמנית, נסה שוב מאוחר יותר',
  private: 'הסרטון פרטי או דורש התחברות',
  forbidden: 'השרת סירב לבקשת הסרטון (403); נסה לזהות אותו מחדש מהעמוד',
  notfound: 'לא נמצא סרטון בקישור',
  notfoundPage: 'לא נמצא סרטון בקישור, וגם לא בנגן שבתוך העמוד',
  notmedia: 'המקור שהתקבל אינו קובץ וידאו או אודיו תקין',
  verification: 'לא ניתן לבדוק את תקינות הקובץ שהתקבל',
  protected: 'הסרטון מוגן בהגנת העתקה (DRM), ואי אפשר להוריד אותו',
  unavailable: 'הסרטון הוסר או לא זמין',
  network: 'אין חיבור לאינטרנט',
  browserContext: 'העמוד פתוח בכמה סשנים של הדפדפן; השאר אותו פתוח בסשן שבו אתה מחובר',
};
const errorLabel = (kind, fallback, browser) => (kind === 'browserContext' && browser
  ? `העמוד פתוח בכמה סשנים של ${browser.name}; השאר אותו פתוח בסשן שבו אתה מחובר`
  : ERROR_LABELS[kind] || fallback);
const LOOKUP_GAP_MS = 2000; // plus up to the same again at random
const DOWNLOAD_REST_MS = 5000; // 5–10 seconds between YouTube downloads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_RE =/https?:\/\/[^\s<>"']+/;

// "שיעור מספר 2: https://..." -> { label: "שיעור מספר 2", url }
function parseLinks(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = line.match(URL_RE);
    if (!m) return null;
    const label = line.slice(0, m.index).replace(/[\s:–\-|]+$/, '').trim();
    return { url: m[0], label };
  }).filter(Boolean);
}

// Which site a link belongs to, from the URL alone so it works before the lookup finishes.
// Blocks are tracked per site key: "youtube", "tiktok", "vimeo", ...
function siteKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile|vm)\./, '');
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    const parts = host.split('.');
    return parts.length > 1 ? parts[parts.length - 2] : host;
  } catch {
    return 'unknown';
  }
}

const SITE_LABELS = { youtube: 'יוטיוב', tiktok: 'טיקטוק', instagram: 'אינסטגרם', vimeo: 'Vimeo', facebook: 'פייסבוק', x: 'X', twitter: 'X' };
const siteLabel = (key) => SITE_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);

function siteInfo(site) {
  if (!site) return null;
  const key = site.toLowerCase();
  return SITES.find((s) => key.includes(s.key)) || { name: site, color: '#8b8fa3', letter: site[0]?.toUpperCase() || '?' };
}

function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtQuality(h) {
  if (!h) return '';
  return h >= 2160 ? '4K' : h >= 1440 ? '2K' : `${h}p`;
}

function SiteMark({ site, size = 16 }) {
  const s = siteInfo(site);
  if (!s) return null;
  return (
    <span className="site-mark" style={{ background: s.color, width: size, height: size, fontSize: size * 0.55 }}>
      {s.icon
        ? <svg viewBox="0 0 24 24" width={size * 0.66} height={size * 0.66} fill="#fff" aria-hidden="true"><path d={s.icon.path} /></svg>
        : s.letter}
    </span>
  );
}

function engineMessage(state, version) {
  if (!state) return version ? 'המנוע מוכן' : 'המנוע לא נמצא';
  if (state.status === 'checking') return 'בודק עדכונים…';
  const r = state.result || {};
  if (r.busy) return 'אי אפשר לעדכן בזמן הורדה';
  if (!r.ok) return 'העדכון נכשל. בדוק את החיבור לאינטרנט';
  return r.updated ? `עודכן לגרסה ${r.after}` : 'המנוע מעודכן לגרסה האחרונה';
}

function UpdateBanner({ status, onDownload, onInstall }) {
  if (!status || !['available', 'downloading', 'ready'].includes(status.state)) return null;
  return (
    <div className="update-banner">
      <Sparkles size={20} />
      <div className="update-text">
        {status.state === 'available' && <>גרסה חדשה של Grab זמינה: <b>{status.version}</b></>}
        {status.state === 'downloading' && (
          <>
            מוריד את העדכון… {status.percent || 0}%
            <div className="progress update-progress"><div style={{ width: `${status.percent || 0}%` }} /></div>
          </>
        )}
        {status.state === 'ready' && <>העדכון לגרסה <b>{status.version}</b> מוכן. הפעל מחדש כדי להתקין.</>}
      </div>
      {status.state === 'available' && <button className="btn-primary small" onClick={onDownload}><Download size={16} /> עדכן עכשיו</button>}
      {status.state === 'ready' && <button className="btn-primary small" onClick={onInstall}><RefreshCw size={16} /> הפעל מחדש</button>}
    </div>
  );
}

function Sidebar({ version, appVersion, page, onNavigate, engine }) {
  const failed = engine.state?.result && !engine.state.result.ok;
  return (
    <aside className="sidebar">
      <div className="brand"><img className="brand-lockup" src={brandLockup} alt="Grab" draggable={false} /></div>
      <nav>
        {PAGES.map(({ id, icon: Icon, label }) => (
          <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => onNavigate(id)}>
            <span>{label}</span>
            <Icon size={20} />
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div><span className={`dot ${!version || failed ? 'dot-off' : ''}`} /> {engineMessage(engine.state, version)}</div>
        <div className="muted">גרסה {appVersion || '…'}{version ? ` · yt-dlp ${version}` : ''}</div>
        <button className="update-link" onClick={engine.update} disabled={engine.state?.status === 'checking' || engine.busy}
          title={engine.busy ? 'אפשר לעדכן כשאין הורדה פעילה' : 'בודק אם יש גרסה חדשה של מנוע ההורדות ומתקין אותה'}>
          <RefreshCw size={14} className={engine.state?.status === 'checking' ? 'spin' : ''} /> עדכון מנוע
        </button>
      </div>
    </aside>
  );
}

function QueueItem({ item, index, actions, drag }) {
  const isError = item.status === 'error';
  const waiting = item.status === 'waiting';
  const analyzing = item.status === 'analyzing' || waiting;
  const site = siteInfo(item.site);
  const meta = [site?.name, fmtDuration(item.duration), fmtQuality(item.height)].filter(Boolean).join(' · ');

  return (
    <div
      className={`queue-item is-${item.status} ${drag.over === index ? 'drag-over' : ''}`}
      draggable
      onDragStart={() => drag.start(index)}
      onDragOver={(e) => { e.preventDefault(); drag.enter(index); }}
      onDrop={() => drag.drop(index)}
      onDragEnd={drag.end}
    >
      <GripVertical size={18} className="grip" />
      <div className={`thumb ${isError ? 'thumb-error' : ''}`}>
        {isError ? <Unlink size={26} /> : waiting ? <Clock size={24} /> : analyzing ? <Loader2 size={24} className="spin" /> : (
          <>
            {item.thumbnail && <img src={item.thumbnail} alt="" />}
            <span className="play"><Play size={16} fill="#fff" /></span>
            {item.duration ? <span className="duration">{fmtDuration(item.duration)}</span> : null}
          </>
        )}
      </div>
      <div className="item-info">
        {analyzing ? <div className="item-name muted">{waiting ? (item.label || 'ממתין לזיהוי') : item.phase === 'page' ? 'מחפש את הסרטון בתוך הנגן שבעמוד…' : item.phase === 'browser' ? `מנסה דרך ${item.phaseBrowser || 'הדפדפן'} שלך…` : 'מזהה סרטון…'}</div> : (
          <input
            className="item-name name-input"
            value={item.name}
            disabled={item.status === 'downloading' || item.status === 'done'}
            onChange={(e) => actions.rename(item.id, e.target.value)}
          />
        )}
        <div className="item-meta">
          {isError || analyzing
            ? (<><span className="url" dir="ltr">{item.url}</span> <Link2 size={13} /></>)
            : (<><SiteMark site={item.site} /> <span>{meta}</span></>)}
        </div>
      </div>

      <div className="item-status">
        {item.status === 'downloading' && (
          <div className="progress-wrap">
            <div className="progress-top">
              <span className="pct">{Math.round(item.progress || 0)}%</span>
              <span className="muted">{[item.speed, item.eta && `נותרו ${item.eta}`].filter(Boolean).join(' · ')}</span>
            </div>
            <div className="progress"><div style={{ width: `${item.progress || 0}%` }} /></div>
          </div>
        )}
        {item.status === 'ready' && <span className="pill">מוכן להורדה</span>}
        {waiting && <span className="pill">ממתין לזיהוי</span>}
        {item.status === 'paused' && <span className="pill">מושהה · {Math.round(item.progress || 0)}%</span>}
        {item.status === 'done' && <span className="pill pill-success"><Check size={15} /> הושלם</span>}
        {item.status === 'queued' && <span className="pill">בתור</span>}
        {isError && <span className="pill pill-danger" title={item.error}><AlertTriangle size={15} /> {item.errorLabel || 'לא נמצא סרטון בקישור'}</span>}
        {isError && item.signInHint && <button className="link-btn" onClick={() => actions.signInGuide(item.url)}>האתר דורש התחברות? כך מורידים ממנו</button>}
      </div>

      <div className="item-actions">
        {item.status === 'ready' && (
          <button className="icon-btn accent" title="הורד רק את זה" onClick={() => actions.downloadOne(item.id)}><Download size={18} /></button>
        )}
        {item.status === 'done' && (
          <button className="icon-btn" title="הצג בתיקייה" onClick={() => actions.show(item)}><FolderOpen size={18} /></button>
        )}
        {item.status === 'downloading' && (
          <button className="icon-btn" title="השהה" onClick={() => actions.pause(item.id)}><Pause size={18} /></button>
        )}
        {item.status === 'paused' && (
          <button className="icon-btn" title="המשך" onClick={() => actions.resume(item.id)}><Play size={18} /></button>
        )}
        {item.status === 'queued' && <span className="icon-btn passive" title="ממתין לתורו"><Clock size={18} /></span>}
        {isError && (
          <button className="icon-btn danger" title="נסה שוב" onClick={() => actions.retry(item)}><RotateCw size={18} /></button>
        )}
        {item.status !== 'analyzing' && (
          <button className="icon-btn" title="הסר מהרשימה" onClick={() => actions.remove(item.id)}><Trash2 size={18} /></button>
        )}
      </div>
    </div>
  );
}

let nextId = 1;

export default function App() {
  const [links, setLinks] = useState('');
  const [queue, setQueue] = useState([]);
  const [settings, setSettings] = useState({ folder: '', format: 'mp4', quality: 'best' });
  const [version, setVersion] = useState(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState('downloads');
  const [engineState, setEngineState] = useState(null);
  const [appVersion, setAppVersion] = useState('');
  const [appUpdate, setAppUpdate] = useState(null); // { state: available|downloading|ready|none|error, version, percent }
  const [sites, setSites] = useState(null);
  const [sitesError, setSitesError] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [guide, setGuide] = useState(null);

  // Never leave the sites window spinning: any failure turns into an error with a retry button.
  const loadSites = useCallback(async () => {
    setSitesError(false);
    try {
      if (!api?.extractors) throw new Error('missing');
      const list = await api.extractors();
      if (!Array.isArray(list) || !list.length) throw new Error('empty');
      setSites(list);
    } catch {
      setSitesError(true);
    }
  }, []);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const parsed = useMemo(() => parseLinks(links), [links]);

  const update = useCallback((id, patch) => {
    setQueue((q) => q.map((x) => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)));
  }, []);

  useEffect(() => {
    if (!api) { setNotice('התצוגה הזו רצה בדפדפן. כדי להוריד, פתח את Grab כאפליקציה.'); return; }
    api.getSettings().then(setSettings);
    api.version().then(setVersion);
    loadSites();
    api.appVersion?.().then(setAppVersion);
    const offUpdate = api.onAppUpdate ? api.onAppUpdate(setAppUpdate) : null;
    // "Looking inside the page's player": shown on the item while that slower search runs.
    const offPhase = api.onLookupPhase ? api.onLookupPhase(({ url, phase, browser }) => {
      setQueue((q) => q.map((x) => (x.url === url && x.status === 'analyzing' ? { ...x, phase, phaseBrowser: browser } : x)));
    }) : null;
    const offProgress = api.onProgress(({ id, percent, speed, eta }) => {
      update(id, { progress: percent, speed, eta: eta && eta !== 'NA' && eta !== 'Unknown' ? eta : '' });
    });
    return () => { offProgress(); offUpdate?.(); offPhase?.(); };
  }, [update]);

  const saveSettings = (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    api?.setSettings(patch);
  };

  // A block is per site: when YouTube blocks us, only YouTube items wait (each further request
  // would extend the block), while downloads from other sites carry on.
  const [blockedSites, setBlockedSites] = useState([]);
  const blockedRef = useRef(new Set());
  const isBlocked = (item) => blockedRef.current.has(siteKey(item.url));
  const setBlockedList = (set) => { blockedRef.current = set; setBlockedSites([...set]); };
  const triggerBlock = useCallback((key) => {
    if (blockedRef.current.has(key)) return;
    setBlockedList(new Set([...blockedRef.current, key]));
  }, []);
  const resumeSite = (key) => {
    const next = new Set(blockedRef.current);
    next.delete(key);
    setBlockedList(next);
    if (queueRef.current.some((x) => x.status === 'queued')) setRunning(true);
  };
  const clearBlocks = () => setBlockedList(new Set());

  // forcePage: go straight to looking inside the page's player (after a download from what
  // yt-dlp found at the link failed). autoQueue: download right away once found.
  const analyzeOne = useCallback(async (id, url, label, { forcePage = false, autoQueue = false } = {}) => {
    update(id, { status: 'analyzing', error: null, errorLabel: null, signInHint: false, phase: forcePage ? 'page' : null });
    let info;
    try { info = await api.analyze(url, { forcePage }); }
    catch (error) { info = { ok: false, error: error.message }; }
    if (!info.ok) {
      if (info.kind === 'blocked') {
        update(id, { status: 'waiting' }); // looked up again once the user resumes this site
        triggerBlock(siteKey(url));
        return;
      }
      update(id, { status: 'error', error: info.error, errorLabel: errorLabel(info.kind, 'לא נמצא סרטון בקישור', info.browser), signInHint: !!info.browser && info.kind !== 'browserContext', analyzeFailed: true });
      return;
    }
    update(id, (x) => ({
      status: autoQueue ? 'queued' : 'ready', forcePage: false, autoQueue: false,
      analyzeFailed: false, site: info.site, duration: info.duration, height: info.height,
      thumbnail: info.thumbnail, title: info.title, name: x.nameEdited ? x.name : (label || info.title),
      infoFile: info.infoFile, infoAt: info.infoAt, infoExpiresAt: info.infoExpiresAt || null,
      // Found inside the page's player: download from that address, as the page does.
      mediaUrl: info.mediaUrl || null, referer: info.referer || null,
      cookieRef: info.cookieRef || null, requestContext: info.requestContext || null,
    }));
    if (autoQueue) setRunning(true);
  }, [update, triggerBlock]);

  // Lookup runner: one "waiting" link at a time with a randomized gap, so sites don't flag us as a bot.
  const lookupBusy = useRef(false);
  const runLookups = useCallback(async () => {
    if (lookupBusy.current) return;
    lookupBusy.current = true;
    let first = true;
    for (;;) {
      const next = queueRef.current.find((x) => x.status === 'waiting' && !isBlocked(x));
      if (!next) break;
      if (!first) await sleep(LOOKUP_GAP_MS + Math.random() * LOOKUP_GAP_MS);
      if (isBlocked(next)) continue; // its site got blocked while we waited
      first = false;
      await analyzeOne(next.id, next.url, next.label, { forcePage: !!next.forcePage, autoQueue: !!next.autoQueue });
      await sleep(0); // let the queue state settle before picking the next one
    }
    lookupBusy.current = false;
  }, [analyzeOne]);

  useEffect(() => {
    if (api && queue.some((x) => x.status === 'waiting' && !isBlocked(x))) runLookups();
  }, [queue, blockedSites, runLookups]);

  const newItem = (url, label, extra = {}) => ({ id: nextId++, url, label, name: label, status: 'waiting', progress: 0, ...extra });

  const requeue = (h) => {
    if (!queueRef.current.some((x) => x.url === h.url)) {
      setQueue((q) => [...q, newItem(h.url, h.name, { nameEdited: true })]);
    }
    setPage('downloads');
  };

  const identify = () => {
    if (!api || !parsed.length) return;
    const existing = new Set(queueRef.current.map((x) => x.url));
    const fresh = parsed.filter((p) => !existing.has(p.url));
    setQueue((q) => [...q, ...fresh.map((p) => newItem(p.url, p.label))]);
    setLinks('');
    if (fresh.length < parsed.length) setNotice(`${parsed.length - fresh.length} קישורים כבר היו בתור ודילגתי עליהם`);
  };

  // Download runner: one video at a time, in queue order, with a short rest between YouTube videos.
  const [restUntil, setRestUntil] = useState(0);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running || !api) return;
    if (queue.some((x) => x.status === 'downloading')) return;
    // Items from a blocked site stay queued and are skipped until the user resumes that site.
    const next = queue.find((x) => x.status === 'queued' && !blockedSites.includes(siteKey(x.url)));
    if (!next) { setRunning(false); return; }

    const isYouTube = !next.site || /youtube/i.test(next.site);
    const wait = restUntil - Date.now();
    if (isYouTube && wait > 0) {
      const t = setTimeout(() => setTick((n) => n + 1), wait);
      return () => clearTimeout(t);
    }

    update(next.id, { status: 'downloading', speed: '', eta: '' });
    api.start({
      id: next.id, url: next.url, name: next.name, folder: settings.folder, format: settings.format, quality: settings.quality,
      infoFile: next.infoFile, infoAt: next.infoAt, infoExpiresAt: next.infoExpiresAt, mediaUrl: next.mediaUrl, referer: next.referer,
      cookieRef: next.cookieRef, requestContext: next.requestContext,
    }).then((r) => {
      setRestUntil(Date.now() + DOWNLOAD_REST_MS + Math.random() * DOWNLOAD_REST_MS);
      if (r.ok) {
        api.addHistory({ name: next.name, url: next.url, file: r.file, site: siteInfo(next.site)?.name || null, format: settings.format });
        return update(next.id, { status: 'done', progress: 100, file: r.file });
      }
      if (r.stopped) return; // paused or removed by the user
      if (r.kind === 'blocked') {
        update(next.id, { status: 'queued', infoFile: null }); // resumes from where it stopped
        return triggerBlock(siteKey(next.url));
      }
      // One automatic retry. A generic page whose download failed often had its real video inside
      // the page's own player, so that retry looks there; otherwise it fetches fresh info in case
      // the saved stream links expired.
      update(next.id, (x) => (x.autoRetried
        ? { status: 'error', error: r.error, errorLabel: errorLabel(r.kind, 'ההורדה נכשלה') }
        : x.mediaUrl || /^(generic|html5mediaembed)$/i.test(x.site || '')
          ? { status: 'waiting', autoRetried: true, forcePage: true, autoQueue: true, infoFile: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null }
          : { status: 'queued', autoRetried: true, infoFile: null }));
    }).catch((error) => update(next.id, { status: 'error', error: error.message, errorLabel: 'ההורדה נכשלה' }));
  }, [queue, running, blockedSites, restUntil, settings, update, triggerBlock]);

  const downloadAll = () => {
    if (!api) return;
    setQueue((q) => q.map((x) => (x.status === 'ready' || x.status === 'paused' ? { ...x, status: 'queued' } : x)));
    clearBlocks();
    setRunning(true);
  };

  const updateEngine = async () => {
    if (!api?.updateEngine) return;
    setEngineState({ status: 'checking' });
    const result = await api.updateEngine();
    setEngineState({ status: 'done', result });
    if (result.ok) {
      setVersion(result.after);
      if (result.updated) { setSites(null); loadSites(); }
    }
  };
  const checkAppUpdate = async () => {
    if (!api?.checkAppUpdate) return;
    setAppUpdate({ state: 'checking' });
    const started = await api.checkAppUpdate();
    if (!started) setAppUpdate({ state: 'dev' }); // only the installed app can update itself
  };

  const engine = {
    state: engineState,
    update: updateEngine,
    busy: running || queue.some((x) => x.status === 'downloading'),
    message: engineMessage(engineState, version),
  };

  const resting = running && restUntil > Date.now() && !queue.some((x) => x.status === 'downloading');

  const actions = {
    rename: (id, name) => update(id, { name, nameEdited: true }),
    // Queues just this row; it joins the line behind anything already downloading.
    downloadOne: (id) => {
      const item = queueRef.current.find((x) => x.id === id);
      update(id, { status: 'queued' });
      if (item) resumeSite(siteKey(item.url)); // an explicit click retries even a blocked site
      setRunning(true);
    },
    pause: (id) => { api.stop(id); update(id, { status: 'paused' }); },
    resume: (id) => { update(id, { status: 'queued' }); setRunning(true); },
    retry: (item) => {
      if (item.analyzeFailed) return update(item.id, { status: 'waiting', analyzeFailed: false, error: null });
      if (item.mediaUrl) return update(item.id, { status: 'waiting', autoRetried: false, forcePage: true, autoQueue: true, error: null, infoFile: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null });
      update(item.id, { status: 'queued', autoRetried: false, error: null, infoFile: null });
      setRunning(true);
    },
    remove: (id) => {
      const item = queueRef.current.find((x) => x.id === id);
      if (item?.status === 'downloading') api.stop(id);
      setQueue((q) => q.filter((x) => x.id !== id));
    },
    show: (item) => (item.file ? api.showFile(item.file) : api.openFolder(settings.folder)),
    signInGuide: (url) => setGuide({ url }),
  };

  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const drag = {
    over: dragOver,
    start: (i) => { dragFrom.current = i; },
    enter: (i) => setDragOver(i),
    drop: (to) => {
      const from = dragFrom.current;
      if (from == null || from === to) return;
      setQueue((q) => { const c = [...q]; const [moved] = c.splice(from, 1); c.splice(to, 0, moved); return c; });
    },
    end: () => { dragFrom.current = null; setDragOver(null); },
  };

  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setLinks((l) => (l ? l.replace(/\s*$/, '\n') : '') + t);
    } catch { /* clipboard blocked */ }
  };

  const counts = useMemo(() => ({
    done: queue.filter((x) => x.status === 'done').length,
    failed: queue.filter((x) => x.status === 'error').length,
    pending: queue.filter((x) => ['ready', 'queued', 'paused', 'downloading'].includes(x.status)).length,
  }), [queue]);

  return (
    <div className="app">
      <Sidebar version={version} appVersion={appVersion} page={page} onNavigate={setPage} engine={engine} />
      <main className="main">
        <div className="breadcrumbs"><Home size={16} /> <ChevronLeft size={14} /> <span>{PAGES.find((p) => p.id === page).label}</span></div>

        <UpdateBanner
          status={appUpdate}
          onDownload={() => { setAppUpdate((s) => ({ ...s, state: 'downloading', percent: 0 })); api.downloadAppUpdate(); }}
          onInstall={() => api.installAppUpdate()}
        />

        {page === 'history' && <HistoryPage onRequeue={requeue} />}
        {page === 'library' && <LibraryPage folder={settings.folder} />}
        {page === 'settings' && (
          <SettingsPage
            settings={settings} onChange={saveSettings} version={version} engine={engine}
            app={{ version: appVersion, status: appUpdate, check: checkAppUpdate }}
            onSignInGuide={() => setGuide({})}
          />
        )}

        {page === 'downloads' && (<>
        <header className="page-header">
          <div>
            <h1>הורדה חדשה</h1>
            <p className="subtitle">
              מדביקים קישורים. אנחנו דואגים לשאר.{' '}
              <button className="link-btn" onClick={() => setGuide({})}>קישור לשיעור באתר שצריך להתחבר אליו?</button>
            </p>
          </div>
          <button className="icon-btn big" title="הדבק מהלוח" onClick={pasteFromClipboard}>
            <ClipboardPaste size={20} />
          </button>
        </header>

        {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}

        {blockedSites.map((key) => {
          const others = queue.some((x) => siteKey(x.url) !== key && ['waiting', 'analyzing', 'queued', 'downloading'].includes(x.status));
          return (
            <div className="blocked-banner" key={key}>
              <AlertTriangle size={22} />
              <div>
                <div className="blocked-title">{siteLabel(key)} חסם זמנית. סרטוני {siteLabel(key)} הושהו.</div>
                <div>
                  עצרתי רק את {siteLabel(key)} כדי לא להאריך את החסימה. בדרך כלל זה עובר תוך כמה שעות.
                  {others && ' הורדות מאתרים אחרים ממשיכות כרגיל.'}
                </div>
              </div>
              <button className="btn-ghost" onClick={() => resumeSite(key)}><Play size={16} /> המשך את {siteLabel(key)}</button>
            </div>
          );
        })}

        <section className="card paste-card">
          <label className="card-label">הקישורים שלך</label>
          <textarea
            dir="ltr"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const file = e.dataTransfer.files?.[0];
              if (!file) return;
              e.preventDefault();
              file.text().then((t) => setLinks((l) => (l ? l.replace(/\s*$/, '\n') : '') + t));
            }}
            placeholder="אפשר להדביק כמה קישורים או לגרור קובץ טקסט"
          />
          <div className="paste-footer">
            <div className="sites">
              {SITES.map((s) => (
                <span key={s.name} className="site-chip"><SiteMark site={s.name} size={20} /> {s.name}</span>
              ))}
              <button className="site-chip more-sites" onClick={() => setSitesOpen(true)}>
                {sites ? `ועוד ${(sites.filter((s) => !s.broken && !s.adult).length - SITES.length).toLocaleString('he-IL')} אתרים` : 'כל האתרים'}
                <ChevronLeft size={15} />
              </button>
            </div>
            <div className="paste-actions">
              <span className="count-chip"><Link2 size={16} /> {parsed.length} קישורים זוהו</span>
              <button className="btn-primary" onClick={identify} disabled={!parsed.length}><Sparkles size={18} /> זהה סרטונים</button>
            </div>
          </div>
        </section>

        <div className="queue-header">
          <h2>תור ההורדות <span className="badge">{queue.length}</span></h2>
          {queue.length > 1 && <span className="btn-ghost passive"><ArrowUpDown size={16} /> גרירה לשינוי סדר</span>}
        </div>

        <section className="queue">
          {queue.length === 0 && (
            <div className="empty">
              <Link2 size={28} />
              <div>התור ריק. הדבק קישורים למעלה ולחץ "זהה סרטונים".</div>
            </div>
          )}
          {queue.map((item, i) => (
            <QueueItem key={item.id} item={item} index={i} actions={actions} drag={drag} />
          ))}
        </section>

        <footer className="action-bar">
          <div className="segmented">
            <button className={settings.format === 'mp4' ? 'on' : ''} onClick={() => saveSettings({ format: 'mp4' })}><Video size={17} /> MP4</button>
            <button className={settings.format === 'mp3' ? 'on' : ''} onClick={() => saveSettings({ format: 'mp3' })}><Music size={17} /> MP3</button>
          </div>
          <label className="select">
            <Settings2 size={17} />
            <GlassSelect value={settings.quality} disabled={settings.format === 'mp3'} onChange={(e) => saveSettings({ quality: e.target.value })}>
              {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </GlassSelect>
          </label>
          <div className="action-main">
            <span className="muted summary">
              {resting ? 'הפסקה קצרה לפני הסרטון הבא…' : (
                <>{counts.done ? `${counts.done} הושלמו` : ''}{counts.failed ? ` · ${counts.failed} נכשלו` : ''}</>
              )}
            </span>
            <button className="btn-primary big" onClick={downloadAll} disabled={!counts.pending || running}>
              {running ? <Loader2 size={19} className="spin" /> : <Download size={19} />}
              {running ? 'מוריד…' : `הורד הכול${counts.pending ? ` (${counts.pending})` : ''}`}
            </button>
          </div>
        </footer>
        </>)}
      </main>
      {sitesOpen && <SitesModal sites={sites} error={sitesError} onRetry={loadSites} onClose={() => setSitesOpen(false)} />}
      {guide && <SignInGuideModal pageUrl={guide.url} onClose={() => setGuide(null)} />}
    </div>
  );
}
