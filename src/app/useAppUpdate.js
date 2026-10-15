import { useEffect, useState } from 'react';
import { api } from '../platform/grabApi.js';

// Grab's own version and update state: { state: available|downloading|ready|none|error|checking|dev, version, percent }.
export default function useAppUpdate() {
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState(null);
  useEffect(() => {
    api?.appVersion?.().then(setVersion);
    const off = api?.onAppUpdate ? api.onAppUpdate(setStatus) : null;
    return () => off?.();
  }, []);
  const check = async () => {
    if (!api?.checkAppUpdate) return;
    setStatus({ state: 'checking' });
    const started = await api.checkAppUpdate();
    if (!started) setStatus({ state: 'dev' }); // only the installed app can update itself
  };
  const download = () => { setStatus((s) => ({ ...s, state: 'downloading', percent: 0 })); api.downloadAppUpdate(); };
  const install = () => api.installAppUpdate();
  return { version, status, check, download, install };
}
