import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, getBaseUrl } from '../api/client';

const AppContext = createContext(null);

const MAX_EVENTS = 200;
const MAX_LOGS = 200;
const MAX_ACTIONS = 60;
const TOAST_TTL_MS = 3600;

const DEFAULT_CRAWL_ACTIVITY = {
  status: 'idle',
  throttle: 1,
  currentGym: null,
  batch: null,
  recentActions: [],
};

function coerceEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type && raw.timestamp) return raw;
  return {
    id: raw.id || `${Date.now()}-${Math.random()}`,
    type: raw.type || 'unknown',
    data: raw.data || {},
    timestamp: raw.timestamp || new Date().toISOString(),
  };
}

function toAction(evt) {
  const data = evt?.data || {};
  const t = evt?.timestamp || new Date().toISOString();

  switch (evt?.type) {
    case 'crawl:gym-start':
      return { type: 'gym-start', url: data.url, urlIndex: data.urlIndex || 0, total: data.total || 0, timestamp: t };
    case 'crawl:gym-done':
      return { type: 'gym-done', name: data.gymName || 'Unknown', url: data.url, duration: data.duration || 0, timestamp: t };
    case 'crawl:gym-failed':
      return {
        type: 'gym-failed',
        url: data.url,
        error: data.error || 'Failed',
        attempt: data.attempt || 1,
        isBlock: Boolean(data.isBlock),
        timestamp: t,
      };
    case 'crawl:batch-start':
      return {
        type: 'batch-start',
        batch: data.batchIndex || 0,
        city: data.cityName || 'Unknown',
        urls: data.urlCount || 0,
        timestamp: t,
      };
    case 'crawl:batch-done':
      return {
        type: 'batch-done',
        batch: data.batchIndex || 0,
        city: data.cityName || 'Unknown',
        stats: data.stats || {},
        duration: data.duration || 0,
        timestamp: t,
      };
    case 'crawl:search-start':
      return {
        type: 'search-start',
        city: data.cityName || 'Unknown',
        category: data.category || 'unknown',
        categoryIndex: data.categoryIndex || 0,
        totalCategories: data.totalCategories || 0,
        timestamp: t,
      };
    case 'crawl:search-done':
      return {
        type: 'search-done',
        city: data.cityName || 'Unknown',
        category: data.category || 'unknown',
        found: data.urlsFound || 0,
        total: data.totalUnique || 0,
        timestamp: t,
      };
    case 'crawl:throttle':
      return {
        type: 'throttle',
        multiplier: Number(data.multiplier || 1),
        direction: data.direction || 'slower',
        reason: data.reason,
        timestamp: t,
      };
    case 'crawl:block':
      return { type: 'block', reason: data.reason, cooldown: data.cooldownMs || 0, timestamp: t };
    case 'crawl:human-pause':
      return { type: 'pause', duration: data.pauseMs || 0, timestamp: t };
    default:
      return null;
  }
}

function reduceCrawlActivity(prev, evt) {
  const data = evt?.data || {};
  let next = prev;

  switch (evt?.type) {
    case 'crawl:search-start':
      next = {
        ...prev,
        status: 'searching',
        currentGym: {
          url: data.category || '',
          urlIndex: data.categoryIndex || 0,
          total: data.totalCategories || 0,
        },
      };
      break;
    case 'crawl:gym-start':
      next = {
        ...prev,
        status: 'scraping',
        currentGym: {
          url: data.url || '',
          urlIndex: data.urlIndex || 0,
          total: data.total || 0,
        },
      };
      break;
    case 'crawl:batch-start':
      next = {
        ...prev,
        status: 'scraping',
        batch: {
          cityName: data.cityName || 'Unknown',
          batchIndex: data.batchIndex || 0,
          urlCount: data.urlCount || 0,
        },
      };
      break;
    case 'crawl:human-pause':
      next = { ...prev, status: 'paused' };
      break;
    case 'crawl:block':
      next = { ...prev, status: 'blocked' };
      break;
    case 'crawl:throttle':
      next = {
        ...prev,
        throttle: Number(data.multiplier || prev.throttle || 1),
        status: data.reason === 'google_block' ? 'blocked' : prev.status,
      };
      break;
    case 'job:started':
      next = { ...prev, status: 'searching' };
      break;
    case 'job:completed':
    case 'job:failed':
    case 'job:cancelled':
      next = {
        ...prev,
        status: 'idle',
        currentGym: null,
        batch: null,
      };
      break;
    default:
      break;
  }

  const action = toAction(evt);
  if (!action) return next;

  return {
    ...next,
    recentActions: [action, ...next.recentActions].slice(0, MAX_ACTIONS),
  };
}

function resolveSseUrl() {
  const base = getBaseUrl() || window.location.origin;
  const url = new URL('/api/events', base);

  const candidates = ['atlas_api_key', 'api_key', 'apiKey', 'x-api-key'];
  for (const key of candidates) {
    const value = window.localStorage.getItem(key);
    if (value) {
      url.searchParams.set('api_key', value);
      break;
    }
  }

  return url.toString();
}

export function AppProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const [logs, setLogs] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [chainsCache, setChainsCacheState] = useState([]);
  const [crawlActivity, setCrawlActivity] = useState(DEFAULT_CRAWL_ACTIVITY);
  const [confirmState, setConfirmState] = useState({ isOpen: false, message: '', resolve: null });

  const sourceRef = useRef(null);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const setChainsCache = useCallback((items) => {
    setChainsCacheState(Array.isArray(items) ? items : []);
  }, []);

  const toast = useCallback((msg, type = 'info') => {
    if (!msg) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, msg: String(msg), type };

    setToasts((prev) => [entry, ...prev].slice(0, 6));

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  const confirm = useCallback((message) => {
    return new Promise((resolve) => {
      setConfirmState({ isOpen: true, message, resolve });
    });
  }, []);

  const closeConfirm = useCallback((result) => {
    setConfirmState(prev => {
      if (prev.resolve) prev.resolve(result);
      return { ...prev, isOpen: false, resolve: null };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      try {
        const res = await api.get('/api/events/history?limit=100');
        if (!res?.success || cancelled) return;

        const history = Array.isArray(res.events) ? res.events.map(coerceEvent).filter(Boolean) : [];
        const ordered = history.reverse();

        setEvents(ordered.slice(0, MAX_EVENTS));
        setCrawlActivity(() => ordered.reduce((state, evt) => reduceCrawlActivity(state, evt), DEFAULT_CRAWL_ACTIVITY));

        const initialLogs = ordered
          .filter((e) => e.type === 'system:log')
          .map((e) => ({ timestamp: e.data?.timestamp || e.timestamp, level: e.data?.level || 'info', message: e.data?.message || '', stack: e.data?.stack }))
          .slice(0, MAX_LOGS);

        setLogs(initialLogs);
      } catch {
        // Ignore history bootstrap errors; live stream can still recover.
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const url = resolveSseUrl();
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
    };

    source.onerror = () => {
      setConnected(false);
    };

    source.onmessage = (event) => {
      if (!event?.data) return;

      try {
        const parsed = coerceEvent(JSON.parse(event.data));
        if (!parsed) return;

        setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
        setCrawlActivity((prev) => reduceCrawlActivity(prev, parsed));

        if (parsed.type === 'system:log') {
          const log = {
            timestamp: parsed.data?.timestamp || parsed.timestamp,
            level: parsed.data?.level || 'info',
            message: parsed.data?.message || '',
            stack: parsed.data?.stack,
          };
          setLogs((prev) => [log, ...prev].slice(0, MAX_LOGS));
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, []);

  const value = useMemo(() => ({
      connected,
      events,
      logs,
      toasts,
      toast,
      clearLogs,
      chainsCache,
      setChainsCache,
      crawlActivity,
      confirm,
      confirmState,
      closeConfirm,
    }),
    [connected, events, logs, toasts, toast, clearLogs, chainsCache, setChainsCache, crawlActivity, confirm, confirmState, closeConfirm]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within AppProvider');
  }
  return ctx;
}
