import React from 'react';
import { siteInfo } from '../presentation/sitePresentation.js';

// A small brand-colored badge for a site (its logo, or its first letter).
export default function SiteMark({ site, size = 16 }) {
  const s = siteInfo(site);
  if (!s) return null;
  return (
    <span className="site-mark" style={{ background: s.color, width: size, height: size, fontSize: size * 0.55 }}>
      {s.icon
        ? <svg viewBox="0 0 24 24" width={size * 0.66} height={size * 0.66} fill="#fff" aria-hidden="true"><path d={s.icon.path} /></svg>
        : s.letter}
    </span>
  );
}
