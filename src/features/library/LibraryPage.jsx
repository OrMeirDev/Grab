import React, { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Folder } from 'lucide-react';
import { api } from '../../platform/grabApi.js';
import PageHeader from '../../design/PageHeader.jsx';
import EmptyState from '../../design/EmptyState.jsx';
import { fmtSize } from '../../presentation/formatters.js';
import LibraryFileRow from './LibraryFileRow.jsx';

export default function LibraryPage({ folder }) {
  const [files, setFiles] = useState(null);
  const [q, setQ] = useState('');

  const load = () => { setFiles(null); api.listLibrary().then(setFiles); };
  useEffect(() => { if (folder) load(); }, [folder]);

  const shown = useMemo(() => (files || []).filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())), [files, q]);
  const total = useMemo(() => (files || []).reduce((s, f) => s + f.size, 0), [files]);

  return (
    <>
      <PageHeader title="ספרייה" subtitle={`הקבצים בתיקיית ההורדות${files ? ` · ${files.length} קבצים · ${fmtSize(total)}` : ''}`}>
        <button className="btn-ghost" onClick={load}><RefreshCw size={16} /> רענן</button>
        <button className="btn-ghost" onClick={() => api.openFolder()}><Folder size={16} /> פתח תיקייה</button>
      </PageHeader>
      {files?.length > 0 && (
        <label className="search"><Search size={17} /><input placeholder="חיפוש לפי שם" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      )}
      <section className="list">
        {files === null && <div className="empty">טוען…</div>}
        {files?.length === 0 && <EmptyState icon={Folder} text="אין עדיין קבצים בתיקיית ההורדות." />}
        {shown.map((f) => (
          <LibraryFileRow key={f.file} file={f} onOpen={() => api.openFile(f.file)} onShow={() => api.showFile(f.file)} />
        ))}
      </section>
    </>
  );
}
