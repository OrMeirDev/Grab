import { useCallback, useState } from 'react';
import { api } from '../../platform/grabApi.js';

// yt-dlp's list of supported sites. Never leaves the sites window spinning: any failure turns into
// an error with a retry button.
export default function useSupportedSites() {
  const [sites, setSites] = useState(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    setError(false);
    try {
      if (!api?.extractors) throw new Error('missing');
      const list = await api.extractors();
      if (!Array.isArray(list) || !list.length) throw new Error('empty');
      setSites(list);
    } catch {
      setError(true);
    }
  }, []);
  // After an engine update the list may differ: forget it and load it again.
  const reload = useCallback(() => { setSites(null); load(); }, [load]);
  return { sites, error, load, reload };
}
