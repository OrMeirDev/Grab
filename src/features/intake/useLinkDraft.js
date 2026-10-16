import { useMemo, useState } from 'react';
import { parseLinks } from '../../domain/intake/parseLinks.js';

// The text in the links box (kept while switching pages) and the links found in it.
export default function useLinkDraft() {
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseLinks(text), [text]);
  // Pasted or dropped text goes on a new line after what is already there.
  const append = (t) => setText((l) => (l ? l.replace(/\s*$/, '\n') : '') + t);
  const pasteFromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) append(t);
    } catch { /* clipboard blocked */ }
  };
  return { text, setText, parsed, append, pasteFromClipboard, clear: () => setText('') };
}
