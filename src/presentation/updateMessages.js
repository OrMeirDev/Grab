// Structured engine/app update states -> the Hebrew line shown for them.

export function engineMessage(state, version) {
  if (!state) return version ? 'המנוע מוכן' : 'המנוע לא נמצא';
  if (state.status === 'checking') return 'בודק עדכונים…';
  const r = state.result || {};
  if (r.busy) return 'אי אפשר לעדכן בזמן הורדה';
  if (!r.ok) return 'העדכון נכשל. בדוק את החיבור לאינטרנט';
  return r.updated ? `עודכן לגרסה ${r.after}` : 'המנוע מעודכן לגרסה האחרונה';
}

export function appUpdateMessage(status) {
  switch (status?.state) {
    case 'checking': return 'בודק אם יש גרסה חדשה…';
    case 'none': return 'Grab מעודכן לגרסה האחרונה';
    case 'available': return `גרסה ${status.version} זמינה. אפשר לעדכן מהפס למעלה.`;
    case 'downloading': return `מוריד את העדכון… ${status.percent || 0}%`;
    case 'ready': return `גרסה ${status.version} מוכנה. הפעל מחדש כדי להתקין.`;
    case 'error': return 'הבדיקה נכשלה. בדוק את החיבור לאינטרנט.';
    case 'dev': return 'בדיקת עדכונים פועלת רק בגרסה המותקנת.';
    default: return 'Grab בודק עדכונים בכל הפעלה וכל 4 שעות.';
  }
}
