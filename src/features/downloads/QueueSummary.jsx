import React from 'react';

export default function QueueSummary({ resting, counts }) {
  return (
    <span className="muted summary">
      {resting ? 'הפסקה קצרה לפני הסרטון הבא…' : (
        <>{counts.done ? `${counts.done} הושלמו` : ''}{counts.failed ? ` · ${counts.failed} נכשלו` : ''}</>
      )}
    </span>
  );
}
