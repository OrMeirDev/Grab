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
  if (item.phase === 'page') return 'מחפש את הסרטון בתוך הנגן שבעמוד…';
  if (item.phase === 'browser') return `מנסה דרך ${item.phaseBrowser || 'הדפדפן'} שלך…`;
  return 'מזהה סרטון…';
}
