import React from 'react';
import { RefreshCw } from 'lucide-react';
import PageHeader from '../../design/PageHeader.jsx';
import { appUpdateMessage } from '../../presentation/updateMessages.js';
import OutputPreferences from './OutputPreferences.jsx';

export default function SettingsPage({ settings, onChange, version, engine, app, onSignInGuide, browserPanel }) {
  const checking = engine?.state?.status === 'checking';
  const failed = engine?.state?.result && !engine.state.result.ok;
  return (
    <>
      <PageHeader title="הגדרות" subtitle="ברירות המחדל לכל הורדה חדשה. נשמרות אוטומטית." />
      <section className="card settings">
        <OutputPreferences settings={settings} onChange={onChange} />
        <div className="setting">
          <div>
            <div className="setting-title">הורדה מאתר שצריך להתחבר אליו</div>
            <div className="row-meta">כשהקישור הוא לשיעור או לעמוד באתר, ולא לסרטון עצמו. הגדרה חד־פעמית בדפדפן.</div>
          </div>
          <button className="btn-ghost" onClick={onSignInGuide}>מדריך קצר</button>
        </div>
        <div className="setting">
          <div>
            <div className="setting-title">עדכוני תוכנה</div>
            <div className="row-meta">גרסה {app?.version || '…'}</div>
            <div className={`row-meta ${app?.status?.state === 'error' ? 'tag-muted' : ''}`}>{appUpdateMessage(app?.status)}</div>
          </div>
          <button className="btn-ghost" onClick={app?.check} disabled={['checking', 'downloading'].includes(app?.status?.state)}>
            <RefreshCw size={16} className={app?.status?.state === 'checking' ? 'spin' : ''} /> בדוק עדכונים
          </button>
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
      {browserPanel}
    </>
  );
}
