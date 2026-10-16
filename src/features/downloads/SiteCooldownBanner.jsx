import React from 'react';
import { AlertTriangle, Play } from 'lucide-react';
import { siteLabel } from '../../presentation/sitePresentation.js';

// "YouTube blocked us for now": shown per blocked site, with the explicit resume command.
// othersActive: downloads from other sites are still going.
export default function SiteCooldownBanner({ siteKey, othersActive, onResume }) {
  const name = siteLabel(siteKey);
  return (
    <div className="blocked-banner">
      <AlertTriangle size={22} />
      <div>
        <div className="blocked-title">{name} חסם זמנית. סרטוני {name} הושהו.</div>
        <div>
          עצרתי רק את {name} כדי לא להאריך את החסימה. בדרך כלל זה עובר תוך כמה שעות.
          {othersActive && ' הורדות מאתרים אחרים ממשיכות כרגיל.'}
        </div>
      </div>
      <button className="btn-ghost" onClick={() => onResume(siteKey)}><Play size={16} /> המשך את {name}</button>
    </div>
  );
}
