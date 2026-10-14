import { useRef, useState } from 'react';

// Drag-to-reorder for the queue rows. Emits onMove(from, to) with row indexes; owns only the
// drag gesture state (which row is under the pointer).
export default function useQueueReorder(onMove) {
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  return {
    over: dragOver,
    start: (i) => { dragFrom.current = i; },
    enter: (i) => setDragOver(i),
    drop: (to) => {
      const from = dragFrom.current;
      if (from == null || from === to) return;
      onMove(from, to);
    },
    end: () => { dragFrom.current = null; setDragOver(null); },
  };
}
