import React, { useEffect, useState } from 'react';
import { X, AlertTriangle, Copy, Loader2 } from 'lucide-react';
import useBrowserStatus from './useBrowserStatus.js';
import BrowserConnectionStatus from './BrowserConnectionStatus.jsx';

// For a link to a page (a course lesson, a members' area) rather than to the video itself: Grab
// looks through the user's own default browser, where they are already signed in. Explains the
// one-time opt-in; there is no sign-in flow in Grab. Written for people who know nothing about
// computers: one line of why, four short steps, a check button.
export default function BrowserConnectionGuide({ onClose, pageUrl, onSettings }) {
  const { browser, check, test } = useBrowserStatus(pageUrl);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = browser?.name || 'הדפדפן';
  const address = `${browser?.scheme || 'chrome'}://inspect/#remote-debugging`;
  const copy = () => navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal guide" role="dialog" aria-label="הורדה מאתר שצריך להתחבר אליו">
        <div className="modal-head">
          <h2>הורדה מאתר שצריך להתחבר אליו</h2>
          <button className="icon-btn" title="סגור" onClick={onClose}><X size={18} /></button>
        </div>
        <p className="guide-why">
          כשהקישור הוא לשיעור או לעמוד באתר, ולא לסרטון עצמו, Grab צריך לראות את העמוד כמו שאתה רואה אותו.
          לכן הוא נעזר ב־{name}, שבו אתה כבר מחובר.
        </p>
        <ol className="guide-steps">
          <li>ב־Grab, פתח הגדרות ← דפדפן והרחבה ולחץ התקנה ליד {name}.</li>
          <li>בדפדפן פתח את דף ההרחבות, הפעל Developer mode ובחר Load unpacked.</li>
          <li>בחר את תיקיית ההרחבה שמוצגת ב־Grab, ואז לחץ בדוק חיבור.</li>
          <li>השאר את הפרופיל שבו אתה מחובר פתוח, פתח בו את העמוד ושלח אותו ל־Grab מתוך התוסף. ההורדה מתחילה אוטומטית.</li>
        </ol>
        <div className="guide-foot">
          <button className="btn-primary" onClick={onSettings}>פתח הגדרות דפדפן</button>
          <button className="btn-ghost" onClick={test} disabled={check === 'checking'}>
            {check === 'checking' ? <Loader2 size={16} className="spin" /> : null} בדוק חיבור
          </button>
        </div>
        <BrowserConnectionStatus check={check} name={name} />
        <details><summary>חיבור ישן דרך Remote debugging</summary>
          <p>אם ההרחבה עדיין לא הוגדרה, אפשר להשתמש בחיבור הקודם: פתח את הכתובת, סמן Allow remote debugging ואשר את בקשת הדפדפן.</p>
          <span className="guide-address"><code dir="ltr">{address}</code><button className="btn-ghost small" onClick={copy}><Copy size={14} /> {copied ? 'הועתק' : 'העתק'}</button></span>
        </details>
      </div>
    </div>
  );
}
