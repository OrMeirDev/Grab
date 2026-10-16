import React from 'react';
import { Film, Music } from 'lucide-react';
import { api } from '../../platform/grabApi.js';
import GlassSelect from '../../design/GlassSelect.jsx';

// Where downloads go, and the default format and quality.
export default function OutputPreferences({ settings, onChange }) {
  const choose = async () => {
    const dir = await api.chooseFolder();
    if (dir) onChange({ folder: dir });
  };
  return (
    <>
      <div className="setting">
        <div><div className="setting-title">תיקיית הורדות</div><div className="row-meta" dir="auto">{settings.folder}</div></div>
        <div className="item-actions">
          <button className="btn-ghost" onClick={() => api.openFolder()}>פתח</button>
          <button className="btn-ghost" onClick={choose}>שנה תיקייה</button>
        </div>
      </div>
      <div className="setting">
        <div><div className="setting-title">פורמט</div><div className="row-meta">MP4 לווידאו, MP3 לאודיו בלבד</div></div>
        <div className="segmented">
          <button className={settings.format === 'mp4' ? 'on' : ''} onClick={() => onChange({ format: 'mp4' })}><Film size={16} /> MP4</button>
          <button className={settings.format === 'mp3' ? 'on' : ''} onClick={() => onChange({ format: 'mp3' })}><Music size={16} /> MP3</button>
        </div>
      </div>
      <div className="setting">
        <div><div className="setting-title">איכות וידאו</div><div className="row-meta">"הגבוהה ביותר" מעדיפה פורמט שמתנגן בכל מכשיר (בדרך כלל עד 1080p)</div></div>
        <GlassSelect className="plain-select" value={settings.quality} onChange={(e) => onChange({ quality: e.target.value })}>
          <option value="best">הגבוהה ביותר</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
        </GlassSelect>
      </div>
    </>
  );
}
