import React from 'react';

// A one-line notice above the intake; clicking it dismisses it.
export default function QueueNotice({ text, onDismiss }) {
  if (!text) return null;
  return <div className="notice" onClick={onDismiss}>{text}</div>;
}
