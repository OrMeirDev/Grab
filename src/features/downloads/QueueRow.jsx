import React from 'react';
import { GripVertical } from 'lucide-react';
import QueueThumb from './QueueThumb.jsx';
import QueueNameEditor from './QueueNameEditor.jsx';
import QueueMetadata from './QueueMetadata.jsx';
import QueueStatus from './QueueStatus.jsx';
import QueueActions from './QueueActions.jsx';

// One queue row: drag handle, thumbnail, name and facts, status, buttons.
export default function QueueRow({ item, index, actions, drag }) {
  return (
    <div
      className={`queue-item is-${item.status} ${drag.over === index ? 'drag-over' : ''}`}
      draggable
      onDragStart={() => drag.start(index)}
      onDragOver={(e) => { e.preventDefault(); drag.enter(index); }}
      onDrop={() => drag.drop(index)}
      onDragEnd={drag.end}
    >
      <GripVertical size={18} className="grip" />
      <QueueThumb item={item} />
      <div className="item-info">
        <QueueNameEditor item={item} onRename={actions.rename} />
        <QueueMetadata item={item} />
      </div>
      <QueueStatus actions={actions} item={item} onSignInGuide={actions.signInGuide} />
      <QueueActions item={item} actions={actions} />
    </div>
  );
}
