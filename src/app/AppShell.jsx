import React, { useEffect, useState } from 'react';
import { Home, ChevronLeft } from 'lucide-react';
import { api } from '../platform/grabApi.js';
import { PAGES } from './routes.js';
import useEngine from './useEngine.js';
import useAppUpdate from './useAppUpdate.js';
import Sidebar from '../components/Sidebar.jsx';
import AppUpdateBanner from '../components/AppUpdateBanner.jsx';
import useLinkDraft from '../features/intake/useLinkDraft.js';
import useSettings from '../features/settings/useSettings.js';
import useDownloads from '../features/downloads/useDownloads.js';
import useSupportedSites from '../features/sites/useSupportedSites.js';
import DownloadsPage from '../features/downloads/DownloadsPage.jsx';
import HistoryPage from '../features/history/HistoryPage.jsx';
import LibraryPage from '../features/library/LibraryPage.jsx';
import SettingsPage from '../features/settings/SettingsPage.jsx';
import SupportedSitesDialog from '../features/sites/SupportedSitesDialog.jsx';
import BrowserSettings from '../features/browser/BrowserSettings.jsx';
import BrowserConnectionGuide from '../features/browser/BrowserConnectionGuide.jsx';

// Composes the screens and owns only navigation, dialogs and the notice line.
export default function AppShell() {
  const draft = useLinkDraft();
  const [settings, saveSettings] = useSettings();
  const downloads = useDownloads();
  const sites = useSupportedSites();
  const engine = useEngine({ busy: downloads.busy, onUpdated: sites.reload });
  const appUpdate = useAppUpdate();
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState('downloads');
  const [sitesOpen, setSitesOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    if (!api) { setNotice('התצוגה הזו רצה בדפדפן. כדי להוריד, פתח את Grab כאפליקציה.'); return; }
    sites.load();
  }, []);

  const identify = async () => {
    if (!api || !draft.parsed.length) return;
    const links = draft.parsed;
    draft.clear();
    const skipped = await downloads.addLinks(links);
    if (skipped) setNotice(`${skipped} קישורים כבר היו בתור ודילגתי עליהם`);
  };
  const requeue = (h) => { downloads.requeue(h); setPage('downloads'); };
  const openGuide = (url) => setGuideOpen({ url: typeof url === 'string' ? url : undefined });

  return (
    <div className="app">
      <Sidebar version={engine.version} appVersion={appUpdate.version} page={page} onNavigate={setPage} engine={engine} />
      <main className="main">
        <div className="breadcrumbs"><Home size={16} /> <ChevronLeft size={14} /> <span>{PAGES.find((p) => p.id === page).label}</span></div>

        <AppUpdateBanner status={appUpdate.status} onDownload={appUpdate.download} onInstall={appUpdate.install} />

        {page === 'history' && <HistoryPage onRequeue={requeue} />}
        {page === 'library' && <LibraryPage folder={settings.folder} />}
        {page === 'settings' && (
          <SettingsPage
            settings={settings} onChange={saveSettings} version={engine.version} engine={engine}
            app={{ version: appUpdate.version, status: appUpdate.status, check: appUpdate.check }}
            onSignInGuide={openGuide} browserPanel={<BrowserSettings />}
          />
        )}
        {page === 'downloads' && (
          <DownloadsPage
            draft={draft} downloads={downloads} sites={sites.sites} settings={settings} onSettings={saveSettings}
            notice={notice} onDismissNotice={() => setNotice('')} onIdentify={identify}
            onShowSites={() => setSitesOpen(true)} onSignInGuide={openGuide} onBrowserSettings={() => setPage('settings')}
          />
        )}
      </main>
      {sitesOpen && <SupportedSitesDialog sites={sites.sites} error={sites.error} onRetry={sites.load} onClose={() => setSitesOpen(false)} />}
      {guideOpen && <BrowserConnectionGuide pageUrl={guideOpen.url} onSettings={() => { setGuideOpen(false); setPage('settings'); }} onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
