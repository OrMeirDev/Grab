import React from 'react';
import { Download, Loader2 } from 'lucide-react';

export default function BatchActions({ running, pending, onDownloadAll }) {
  return (
    <button className="btn-primary big" onClick={onDownloadAll} disabled={!pending || running}>
      {running ? <Loader2 size={19} className="spin" /> : <Download size={19} />}
      {running ? 'מוריד…' : `הורד הכול${pending ? ` (${pending})` : ''}`}
    </button>
  );
}
