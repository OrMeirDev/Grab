import React from 'react';
import { FolderOpen, Play, Film, Music } from 'lucide-react';
import { fmtDate, fmtSize, isAudio } from '../../presentation/formatters.js';

export default function LibraryFileRow({ file, onOpen, onShow }) {
  return (
    <div className="row">
      <span className="row-icon">{isAudio(file.name) ? <Music size={18} /> : <Film size={18} />}</span>
      <div className="row-info">
        <div className="row-name">{file.name.replace(/\.[^.]+$/, '')}</div>
        <div className="row-meta">{[file.folder, fmtSize(file.size), fmtDate(file.modified)].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="item-actions">
        <button className="icon-btn" title="נגן" onClick={onOpen}><Play size={18} /></button>
        <button className="icon-btn" title="הצג בתיקייה" onClick={onShow}><FolderOpen size={18} /></button>
      </div>
    </div>
  );
}
