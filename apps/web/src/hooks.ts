import { useEffect, useRef } from 'react';
import type { GameDockEvent } from '@gamedock/shared';

/** Subscribe to a server-sent event stream while the component is mounted. */
export function useSse(url: string | null, onMessage: (data: unknown) => void): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      try {
        handlerRef.current(JSON.parse(event.data as string));
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [url]);
}

/** Subscribe to the global GameDock event stream (status changes, jobs). */
export function useGameDockEvents(onEvent: (event: GameDockEvent) => void): void {
  useSse('/api/events/stream', (data) => onEvent(data as GameDockEvent));
}
