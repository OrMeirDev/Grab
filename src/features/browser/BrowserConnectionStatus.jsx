import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

// The result line of the "check connection" button.
export default function BrowserConnectionStatus({ check, name }) {
  if (check === 'checking') return <div className="verdict warn"><AlertTriangle size={18} /> אם {name} שואל אם לאשר את החיבור, לחץ אישור.</div>;
  if (check === 'ok') return <div className="verdict ok"><CheckCircle2 size={18} /> מחובר ל־{name}. אפשר לסגור את החלון ולהדביק ב־Grab את הקישור לסרטון.</div>;
  if (check === 'fail') return <div className="verdict no"><XCircle size={18} /> עדיין אין חיבור. ודא ש־{name} פתוח, שהתיבה מסומנת ושאישרת.</div>;
  return null;
}
