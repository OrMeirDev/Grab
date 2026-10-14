import React from 'react';

export default function EmptyState({ icon: Icon, text }) {
  return <div className="empty"><Icon size={28} /><div>{text}</div></div>;
}
