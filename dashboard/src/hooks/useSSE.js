import { useEffect, useRef, useCallback } from 'react';
import { getBaseUrl } from '../api/client';

/**
 * useSSE — Server-Sent Events connection hook
 * @param {function} onEvent - called with parsed event { type, data, timestamp }
 * @param {function} onLog - called with log objects
 * @param {function} onConnectionChange - called with boolean connected state
 * @param {Array} deps - re-connect when these change
 */
export function useSSE(onEvent, onLog, onConnectionChange, deps = []) {
  const esRef = useRef(null);

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();

    const base = getBaseUrl();
    const url = new URL(`${base}/api/events`, window.location.origin);

    const es = new EventSource(url.toString());
    esRef.current = es;

    es.addEventListener('connected', () => onConnectionChange?.(true));

    const eventTypes = [
      'job:queued', 'job:started', 'job:progress', 'job:completed', 'job:failed', 'job:cancelled',
      'job:batches-queued', 'job:promoted',
      'gym:created', 'gym:updated', 'schedule:fired', 'system:startup', 'test:ping', 'system:log',
      // Granular crawl events
      'crawl:gym-start', 'crawl:gym-done', 'crawl:gym-failed',
      'crawl:batch-start', 'crawl:batch-done',
      'crawl:search-start', 'crawl:search-done',
      'crawl:throttle', 'crawl:block', 'crawl:human-pause',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e) => {
        try {
          const event = JSON.parse(e.data);
          if (type === 'system:log') {
            onLog?.(event.data || event);
          } else {
            onEvent?.(event);
          }
        } catch { /* ignore parse errors */ }
      });
    }

    es.onerror = () => onConnectionChange?.(false);
    es.onopen  = () => onConnectionChange?.(true);

    return es;
  }, [onEvent, onLog, onConnectionChange]);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, deps);

  return {
    reconnect: connect,
    close: () => esRef.current?.close(),
  };
}
