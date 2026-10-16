import React from 'react';

// The links box. A dropped text file is appended to it.
export default function LinkInput({ value, onChange, onAppend }) {
  return (
    <textarea
      dir="ltr"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        e.preventDefault();
        file.text().then(onAppend);
      }}
      placeholder="אפשר להדביק כמה קישורים או לגרור קובץ טקסט"
    />
  );
}
