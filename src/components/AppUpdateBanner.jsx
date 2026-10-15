import React from 'react';
import { Download, Sparkles, RefreshCw } from 'lucide-react';

// The "new version of Grab" bar. Presentation only; the parent owns the update commands.
export default function AppUpdateBanner({ status, onDownload, onInstall }) {
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
