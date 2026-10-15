import { useEffect, useState } from 'react';
import { api } from '../platform/grabApi.js';
import { engineMessage } from '../presentation/updateMessages.js';

// The yt-dlp engine: its version and the "update engine" command. busy: downloads are running,
// so the engine can't be replaced. onUpdated runs after a successful update to a new version.
export default function useEngine({ busy, onUpdated }) {
  const [version, setVersion] = useState(null);
  const [state, setState] = useState(null);
  useEffect(() => { api?.version().then(setVersion); }, []);
  const update = async () => {
    if (!api?.updateEngine) return;
    setState({ status: 'checking' });
    const result = await api.updateEngine();
    setState({ status: 'done', result });
    if (result.ok) {
      setVersion(result.after);
      if (result.updated) onUpdated?.();
    }
  };
  return { version, state, update, busy, message: engineMessage(state, version) };
}
