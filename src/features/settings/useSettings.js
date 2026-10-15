import { useEffect, useState } from 'react';
import { api } from '../../platform/grabApi.js';

// Download defaults (folder, format, quality), saved as they change.
export default function useSettings() {
  const [settings, setSettings] = useState({ folder: '', format: 'mp4', quality: 'best' });
  useEffect(() => { api?.getSettings().then(setSettings); }, []);
  const save = (patch) => {
    setSettings((s) => ({ ...s, ...patch }));
    api?.setSettings(patch);
  };
  return [settings, save];
}
