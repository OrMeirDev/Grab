import React from 'react';
import { rowState, lookupLine } from './rowState.js';

// The file name field (editable until the download starts), or the lookup line before that.
export default function QueueNameEditor({ item, onRename }) {
  if (rowState(item).analyzing) return <div className="item-name muted">{lookupLine(item)}</div>;
  return (
    <input
      className="item-name name-input"
      value={item.name}
      disabled={item.status === 'downloading' || item.status === 'done'}
      onChange={(e) => onRename(item.id, e.target.value)}
    />
  );
}
