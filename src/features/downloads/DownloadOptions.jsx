import React from 'react';
import { Video, Music, Settings2 } from 'lucide-react';
import GlassSelect from '../../design/GlassSelect.jsx';

export const QUALITIES = [
  { value: 'best', label: 'האיכות הגבוהה ביותר' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
];

// Format (MP4/MP3) and quality cap for the downloads; saved as the defaults.
export default function DownloadOptions({ settings, onChange }) {
  return (
    <>
      <div className="segmented">
        <button className={settings.format === 'mp4' ? 'on' : ''} onClick={() => onChange({ format: 'mp4' })}><Video size={17} /> MP4</button>
        <button className={settings.format === 'mp3' ? 'on' : ''} onClick={() => onChange({ format: 'mp3' })}><Music size={17} /> MP3</button>
      </div>
      <label className="select">
        <Settings2 size={17} />
        <GlassSelect value={settings.quality} disabled={settings.format === 'mp3'} onChange={(e) => onChange({ quality: e.target.value })}>
          {QUALITIES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
        </GlassSelect>
      </label>
    </>
  );
}
