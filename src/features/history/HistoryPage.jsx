import React, { useEffect, useMemo, useState } from 'react';
import { Trash2, Search, History as HistoryIcon } from 'lucide-react';
import { api } from '../../platform/grabApi.js';
import PageHeader from '../../design/PageHeader.jsx';
import EmptyState from '../../design/EmptyState.jsx';
import HistoryRow from './HistoryRow.jsx';

export default function HistoryPage({ onRequeue }) {
  const [items, setItems] = useState([]);
  const [missing, setMissing] = useState({});
  const [q, setQ] = useState('');

  const load = async () => {
    const list = await api.getHistory();
    setItems(list);
    const flags = {};
    await Promise.all(list.map(async (h, i) => { flags[i] = !(await api.fileExists(h.file)); }));
    setMissing(flags);
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => items
    .map((h, i) => ({ ...h, i }))
    .filter((h) => !q || h.name.toLowerCase().includes(q.toLowerCase())), [items, q]);

  const clear = async () => {
    if (!window.confirm('למחוק את כל ההיסטוריה? הקבצים עצמם לא יימחקו.')) return;
    await api.clearHistory();
    load();
  };

  return (
    <>
      <PageHeader title="היסטוריה" subtitle="כל מה שהורדת, מהחדש לישן.">
        {items.length > 0 && <button className="btn-ghost" onClick={clear}><Trash2 size={16} /> נקה היסטוריה</button>}
      </PageHeader>
      {items.length > 0 && (
        <label className="search"><Search size={17} /><input placeholder="חיפוש לפי שם" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      )}
      <section className="list">
        {items.length === 0 && <EmptyState icon={HistoryIcon} text="עוד לא הורדת כלום. הורדות שיסתיימו יופיעו כאן." />}
        {shown.map((h) => (
          <HistoryRow
            key={h.i} entry={h} missing={missing[h.i]}
            onOpen={() => api.openFile(h.file)} onShow={() => api.showFile(h.file)} onRequeue={() => onRequeue(h)}
          />
        ))}
      </section>
    </>
  );
}
