import React from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import QueueProgress from './QueueProgress.jsx';
import { rowState } from './rowState.js';

export default function QueueStatus({ item, onSignInGuide, actions }) {
  const { isError, waiting } = rowState(item);
  return (
    <div className="item-status">
      {item.status === 'downloading' && <QueueProgress item={item} />}
      {item.status === 'ready' && <span className="pill">מוכן להורדה</span>}
      {waiting && <span className="pill">ממתין לזיהוי</span>}
      {item.status === 'paused' && <span className="pill">מושהה · {Math.round(item.progress || 0)}%</span>}
      {item.status === 'done' && <span className="pill pill-success"><Check size={15} /> הושלם</span>}
      {item.status === 'queued' && <span className="pill">בתור</span>}
      {isError && <span className="pill pill-danger" title={item.error}><AlertTriangle size={15} /> {item.errorLabel || 'לא נמצא סרטון בקישור'}</span>}
      {isError && item.fix === 'settings' && <button className="link-btn" onClick={actions.openBrowserSettings}>הגדרת הדפדפן</button>}
      {isError && item.choices && <span className="choice-row">{item.choices.map((c) => <button key={c.index} className="btn-ghost small" onClick={() => actions.choose(item, c)}>{c.label}</button>)}</span>}
      {item.status === 'analyzing' && item.bphase === 'playback_required' && <button className="link-btn" onClick={() => actions.reveal(item.id)}>הצג את הלשונית ב־{item.bbrowser || 'הדפדפן'}</button>}
      {isError && item.signInHint && <button className="link-btn" onClick={() => onSignInGuide(item.url)}>האתר דורש התחברות? כך מורידים ממנו</button>}
    </div>
  );
}
