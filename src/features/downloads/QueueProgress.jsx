import React from 'react';

export default function QueueProgress({ item }) {
  return (
    <div className="progress-wrap">
      <div className="progress-top">
        <span className="pct">{Math.round(item.progress || 0)}%</span>
        <span className="muted">{[item.speed, item.eta && `נותרו ${item.eta}`].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="progress"><div style={{ width: `${item.progress || 0}%` }} /></div>
    </div>
  );
}
