import React from 'react';
import { FolderOpen, Play, RotateCcw, Film, Music } from 'lucide-react';
import { fmtDate } from '../../presentation/formatters.js';

// One completed download. missing: the file was moved or deleted since.
export default function HistoryRow({ entry, missing, onOpen, onShow, onRequeue }) {
  return (
    <div className="row">
      <span className="row-icon">{entry.format === 'mp3' ? <Music size={18} /> : <Film size={18} />}</span>
      <div className="row-info">
        <div className="row-name">{entry.name}</div>
        <div className="row-meta">
          {[entry.site, fmtDate(entry.completedAt)].filter(Boolean).join(' · ')}
          {missing && <span className="tag-muted"> · הקובץ הועבר או נמחק</span>}
        </div>
      </div>
      <div className="item-actions">
        {!missing && <button className="icon-btn" title="נגן" onClick={onOpen}><Play size={18} /></button>}
        {!missing && <button className="icon-btn" title="הצג בתיקייה" onClick={onShow}><FolderOpen size={18} /></button>}
        <button className="icon-btn" title="הורד שוב" onClick={onRequeue}><RotateCcw size={18} /></button>
      </div>
    </div>
  );
}
