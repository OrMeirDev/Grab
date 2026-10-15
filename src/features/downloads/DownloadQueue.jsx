import React from 'react';
import { ArrowUpDown, Link2 } from 'lucide-react';
import QueueRow from './QueueRow.jsx';

export default function DownloadQueue({ queue, actions, drag }) {
  return (
    <>
      <div className="queue-header">
        <h2>תור ההורדות <span className="badge">{queue.length}</span></h2>
        {queue.length > 1 && <span className="btn-ghost passive"><ArrowUpDown size={16} /> גרירה לשינוי סדר</span>}
      </div>

      <section className="queue">
        {queue.length === 0 && (
          <div className="empty">
            <Link2 size={28} />
            <div>התור ריק. הדבק קישורים למעלה ולחץ "זהה סרטונים".</div>
          </div>
        )}
        {queue.map((item, i) => (
          <QueueRow key={item.id} item={item} index={i} actions={actions} drag={drag} />
        ))}
      </section>
    </>
  );
}
