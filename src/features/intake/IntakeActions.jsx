import React from 'react';
import { ChevronLeft, Link2, Sparkles } from 'lucide-react';
import SiteMark from '../../components/SiteMark.jsx';
import { SITES } from '../../presentation/sitePresentation.js';

// Under the links box: supported sources, link count and the selected lookup action.
export default function IntakeActions({ contentType, sites, linkCount, onShowSites, onIdentify }) {
  return (
    <div className="paste-footer">
      <div className="sites">
        {contentType === 'pdf' ? <span className="subtitle">מסמכי PDF מקוריים מהעמוד</span> : (
          <>
            {SITES.map((s) => (
              <span key={s.name} className="site-chip"><SiteMark site={s.name} size={20} /> {s.name}</span>
            ))}
            <button className="site-chip more-sites" onClick={onShowSites}>
              {sites ? `ועוד ${(sites.filter((s) => !s.broken && !s.adult).length - SITES.length).toLocaleString('he-IL')} אתרים` : 'כל האתרים'}
              <ChevronLeft size={15} />
            </button>
          </>
        )}
      </div>
      <div className="paste-actions">
        <span className="count-chip"><Link2 size={16} /> {linkCount} קישורים זוהו</span>
        <button className="btn-primary" onClick={onIdentify} disabled={!linkCount}>
          <Sparkles size={18} /> {contentType === 'pdf' ? 'זהה קובצי PDF' : 'זהה סרטונים'}
        </button>
      </div>
    </div>
  );
}
