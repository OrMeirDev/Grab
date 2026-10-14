import { useEffect, useState } from 'react';
import { api } from '../../platform/grabApi.js';

// The user's default browser (name, settings address scheme, whether it can be used) and the
// "check connection" test. check: null | 'checking' | 'ok' | 'fail'.
export default function useBrowserStatus() {
  const [browser, setBrowser] = useState(null);
  const [check, setCheck] = useState(null);
  useEffect(() => { api.defaultBrowser?.().then(setBrowser).catch(() => {}); }, []);
  const test = async () => {
    setCheck('checking');
    const r = await api.checkBrowser().catch(() => ({ ok: false }));
    setCheck(r.ok ? 'ok' : 'fail');
  };
  return { browser, check, test };
}
