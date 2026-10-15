import React from 'react';
import { RefreshCw } from 'lucide-react';
// The Grab name with its symbol on the right (vector, from the brand package).
import brandLockup from '../design/assets/brand/logo-lockup.svg';
import { PAGES } from '../app/routes.js';

// Navigation plus the app/engine summary at the bottom.
export default function Sidebar({ version, appVersion, page, onNavigate, engine }) {
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
        <div><span className={`dot ${!version || failed ? 'dot-off' : ''}`} /> {engine.message}</div>
        <div className="muted">גרסה {appVersion || '…'}{version ? ` · yt-dlp ${version}` : ''}</div>
        <button className="update-link" onClick={engine.update} disabled={engine.state?.status === 'checking' || engine.busy}
          title={engine.busy ? 'אפשר לעדכן כשאין הורדה פעילה' : 'בודק אם יש גרסה חדשה של מנוע ההורדות ומתקין אותה'}>
          <RefreshCw size={14} className={engine.state?.status === 'checking' ? 'spin' : ''} /> עדכון מנוע
        </button>
      </div>
    </aside>
  );
}
