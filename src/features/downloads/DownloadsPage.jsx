import React from 'react';
import { ClipboardPaste } from 'lucide-react';
import LinkInput from '../intake/LinkInput.jsx';
import IntakeActions from '../intake/IntakeActions.jsx';
import QueueNotice from './QueueNotice.jsx';
import SiteCooldownBanner from './SiteCooldownBanner.jsx';
import DownloadQueue from './DownloadQueue.jsx';
import DownloadOptions from './DownloadOptions.jsx';
import QueueSummary from './QueueSummary.jsx';
import BatchActions from './BatchActions.jsx';
import useQueueReorder from './useQueueReorder.js';

// The main screen: paste links, identify them, download. Composition only; the queue's owner
// (downloads) and the link draft come from the shell.
export default function DownloadsPage({ contentType, onContentType, draft, downloads, sites, settings, onSettings, notice, onDismissNotice, onIdentify, onShowSites, onSignInGuide, onBrowserSettings }) {
  const drag = useQueueReorder(downloads.move);
  const actions = { ...downloads.actions, signInGuide: onSignInGuide, openBrowserSettings: onBrowserSettings };
  return (
    <>
      <header className="page-header">
        <div>
          <h1>הורדה חדשה</h1>
          <p className="subtitle">
            מדביקים קישורים. אנחנו דואגים לשאר.{' '}
            <button className="link-btn" onClick={onSignInGuide}>קישור לשיעור באתר שצריך להתחבר אליו?</button>
          </p>
        </div>
        <button className="icon-btn big" title="הדבק מהלוח" onClick={draft.pasteFromClipboard}>
          <ClipboardPaste size={20} />
        </button>
      </header>

      <QueueNotice text={notice} onDismiss={onDismissNotice} />

      {downloads.blockedSites.map((b) => (
        <SiteCooldownBanner key={b.key} siteKey={b.key} othersActive={b.othersActive} onResume={downloads.resumeSite} />
      ))}

      <section className="card paste-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label className="card-label" style={{ margin: 0 }}>הקישורים שלך</label>
          <div role="group" aria-label="סוג ההורדה" style={{ display: 'flex', gap: 6 }}>
            <button className="btn-ghost small" aria-pressed={contentType === 'video'} onClick={() => onContentType('video')}>וידאו {contentType === 'video' ? '✓' : ''}</button>
            <button className="btn-ghost small" aria-pressed={contentType === 'pdf'} onClick={() => onContentType('pdf')}>PDF {contentType === 'pdf' ? '✓' : ''}</button>
          </div>
        </div>
        {contentType === 'pdf' && <p className="subtitle">קישור למסמך מקורי או לעמוד עם קובצי PDF. למסמך שדורש התחברות, שלח דרך התוסף.</p>}
        <LinkInput value={draft.text} onChange={draft.setText} onAppend={draft.append} />
        <IntakeActions contentType={contentType} sites={sites} linkCount={draft.parsed.length} onShowSites={onShowSites} onIdentify={onIdentify} />
      </section>

      <DownloadQueue queue={downloads.queue} actions={actions} drag={drag} />

      <footer className="action-bar">
        {contentType === 'pdf' ? <span className="pill">PDF מקורי · ללא המרה</span> : <DownloadOptions settings={settings} onChange={onSettings} />}
        <div className="action-main">
          <QueueSummary resting={downloads.resting} counts={downloads.counts} />
          <BatchActions running={downloads.running} pending={downloads.counts.pending} onDownloadAll={downloads.downloadAll} />
        </div>
      </footer>
    </>
  );
}
