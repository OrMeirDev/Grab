import React from 'react';
import { Download, FolderOpen, Pause, Play, Clock, RotateCw, Trash2 } from 'lucide-react';

// The row's buttons. Each one only emits a command; the queue owner decides what happens.
export default function QueueActions({ item, actions }) {
  return (
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
      {item.status === 'error' && (
        <button className="icon-btn danger" title="נסה שוב" onClick={() => actions.retry(item)}><RotateCw size={18} /></button>
      )}
      {item.status !== 'analyzing' && (
        <button className="icon-btn" title="הסר מהרשימה" onClick={() => actions.remove(item.id)}><Trash2 size={18} /></button>
      )}
    </div>
  );
}
