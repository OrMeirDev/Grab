import React from 'react';
import { Play, Clock, Unlink, Loader2 } from 'lucide-react';
import { fmtDuration } from '../../presentation/formatters.js';
import { rowState } from './rowState.js';

export default function QueueThumb({ item }) {
  const { isError, waiting, analyzing } = rowState(item);
  return (
    <div className={`thumb ${isError ? 'thumb-error' : ''}`}>
      {isError ? <Unlink size={26} /> : waiting ? <Clock size={24} /> : analyzing ? <Loader2 size={24} className="spin" /> : (
        <>
          {item.thumbnail && <img src={item.thumbnail} alt="" />}
          <span className="play"><Play size={16} fill="#fff" /></span>
          {item.duration ? <span className="duration">{fmtDuration(item.duration)}</span> : null}
        </>
      )}
    </div>
  );
}
