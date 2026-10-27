import React from 'react';
import { Link2 } from 'lucide-react';
import SiteMark from '../../components/SiteMark.jsx';
import { siteInfo } from '../../presentation/sitePresentation.js';
import { fmtDuration, fmtQuality } from '../../presentation/formatters.js';
import { rowState } from './rowState.js';

// Site, length and quality once known; the link itself before that or after a failure.
export default function QueueMetadata({ item }) {
  const { isError, analyzing } = rowState(item);
  const meta = [item.contentType === 'pdf' ? 'PDF' : null,item.contentType === 'pdf' ? null : siteInfo(item.site)?.name, fmtDuration(item.duration), fmtQuality(item.height)].filter(Boolean).join(' · ');
  return (
    <div className="item-meta">
      {isError || analyzing
        ? (<><span className="url" dir="ltr">{item.url}</span> <Link2 size={13} /></>)
        : (<><SiteMark site={item.site} /> <span>{meta}</span></>)}
    </div>
  );
}
