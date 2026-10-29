// Display flags of one queue row, derived from its status. Pure.
export function rowState(item) {
  const waiting = item.status === 'waiting';
  return {
    isError: item.status === 'error',
    waiting,
    // "waiting" (for its turn to be looked up) is shown like a lookup in progress
    analyzing: item.status === 'analyzing' || waiting,
  };
}

// The grey line shown instead of the name while a row is being looked up.
export function lookupLine(item) {
  if (item.status === 'waiting') return item.label || 'ממתין לזיהוי';
  const b = item.bbrowser || 'הדפדפן';
  if (item.bphase === 'connecting') return `מתחבר ל־${b}…`;
  if (item.contentType === 'auto') return 'מחפש וידאו וקובצי PDF בעמוד…';
  if (item.contentType === 'pdf') return 'מחפש קובצי PDF בעמוד…';
  if (item.bphase === 'discovering') return `מחפש את הסרטון ב־${b}${item.binstance ? ` (${item.binstance})` : ''}…`;
  if (item.bphase === 'playback_required') return `לחץ Play ב־${b} כדי להמשיך`;
  if (item.bphase === 'validating') return 'בודק שאפשר להוריד את המקור…';
  if (item.phase === 'page') return 'מחפש את הסרטון בתוך הנגן שבעמוד…';
  if (item.phase === 'browser') return `מנסה דרך ${item.phaseBrowser || 'הדפדפן'} שלך…`;
  return 'מזהה סרטון…';
}
