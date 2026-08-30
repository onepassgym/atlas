import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { setEnv, api } from '../api/client';
import { useSSE } from '../hooks/useSSE';
import PinModal from '../components/PinModal';

const AppContext = createContext(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}

export function AppProvider({ children }) {
  const isProdHost = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
  const storedEnv = isProdHost ? 'prod' : (localStorage.getItem('atlas_env') || 'local');

  const [env, setEnvState] = useState(storedEnv);
  const [isAuthenticated, setIsAuthenticated] = useState(() => localStorage.getItem('atlas_auth') === 'true');
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const [logs, setLogs] = useState([]);
  const [chainsCache, setChainsCache] = useState([]);
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);

  // Live crawler activity state — derived from crawl:* events
  const [crawlActivity, setCrawlActivity] = useState({
    currentSpace: null,    // { url, urlIndex, total, startedAt }
    batch: null,         // { cityName, batchIndex, urlCount, startedAt }
    throttle: 1.0,       // Current throttle multiplier
    recentActions: [],   // Last 15 actions for timeline
    status: 'idle',      // 'idle' | 'searching' | 'scraping' | 'paused' | 'blocked'
  });

  // ── Theme ──────────────────────────────────────────────────
  const [theme, setThemeState] = useState(() => {
    const saved = localStorage.getItem('atlas_theme');
    if (saved) return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('atlas_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  // Init API env
  useEffect(() => {
    const prodUrl = isProdHost ? window.location.origin : 'https://atlas.onepassspace.com';
    setEnv(env, prodUrl);
  }, [env, isProdHost]);

  // Toast system
  const toast = useCallback((msg, type = 'info') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // Events
  const handleEvent = useCallback((event) => {
    setEvents(prev => {
      const next = [event, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });

    // Update crawl activity state from crawl:* events
    const d = event.data || {};
    const addAction = (action) => {
      setCrawlActivity(prev => ({
        ...prev,
        recentActions: [{ ...action, timestamp: event.timestamp }, ...prev.recentActions].slice(0, 15),
      }));
    };

    switch (event.type) {
      case 'crawl:space-start':
        setCrawlActivity(prev => ({ ...prev, currentSpace: { url: d.url, urlIndex: d.urlIndex, total: d.total, startedAt: event.timestamp }, status: 'scraping' }));
        addAction({ type: 'space-start', url: d.url, index: `${d.urlIndex}/${d.total}` });
        break;
      case 'crawl:space-done':
        addAction({ type: 'space-done', name: d.spaceName, duration: d.duration });
        break;
      case 'crawl:space-failed':
        addAction({ type: 'space-failed', url: d.url, error: d.error, attempt: d.attempt, isBlock: d.isBlock });
        break;
      case 'crawl:batch-start':
        setCrawlActivity(prev => ({ ...prev, batch: { cityName: d.cityName, batchIndex: d.batchIndex, urlCount: d.urlCount, startedAt: event.timestamp }, status: 'scraping' }));
        addAction({ type: 'batch-start', city: d.cityName, batch: d.batchIndex, urls: d.urlCount });
        break;
      case 'crawl:batch-done':
        setCrawlActivity(prev => ({ ...prev, batch: null, currentSpace: null, status: 'idle' }));
        addAction({ type: 'batch-done', city: d.cityName, batch: d.batchIndex, stats: d.stats });
        break;
      case 'crawl:search-start':
        setCrawlActivity(prev => ({ ...prev, status: 'searching', currentSpace: { url: d.category, urlIndex: d.categoryIndex, total: d.totalCategories, startedAt: event.timestamp } }));
        addAction({ type: 'search-start', city: d.cityName, category: d.category });
        break;
      case 'crawl:search-done':
        addAction({ type: 'search-done', category: d.category, found: d.urlsFound, total: d.totalUnique });
        break;
      case 'crawl:throttle':
        setCrawlActivity(prev => ({ ...prev, throttle: d.multiplier }));
        addAction({ type: 'throttle', multiplier: d.multiplier, direction: d.direction });
        break;
      case 'crawl:block':
        setCrawlActivity(prev => ({ ...prev, status: 'blocked' }));
        addAction({ type: 'block', reason: d.reason, cooldown: d.cooldownMs });
        break;
      case 'crawl:human-pause':
        setCrawlActivity(prev => ({ ...prev, status: 'paused' }));
        addAction({ type: 'pause', duration: d.pauseMs });
        break;
      default:
        break;
    }
  }, []);

  const handleLog = useCallback((log) => {
    setLogs(prev => {
      const next = [log, ...prev];
      return next.length > 200 ? next.slice(0, 200) : next;
    });
  }, []);

  const handleConnection = useCallback((c) => setConnected(c), []);

  // SSE connection
  const { reconnect } = useSSE(handleEvent, handleLog, handleConnection, [env, isAuthenticated]);

  // Env switching  
  const switchEnv = useCallback((newEnv) => {
    localStorage.setItem('atlas_env', newEnv);
    setEnvState(newEnv);
    window.location.reload();
  }, []);

  // Load event history on mount
  useEffect(() => {
    if (!isAuthenticated) return;
    api.get('/api/events/history?limit=150')
      .then(res => {
        if (res?.success && res.events?.length) {
          const all = res.events.reverse();
          setEvents(all.filter(e => e.type !== 'system:log'));
          setLogs(all.filter(e => e.type === 'system:log').map(e => e.data));
        }
      })
      .catch(() => {});
  }, [env, isAuthenticated]);

  const clearLogs = useCallback(() => setLogs([]), []);
  const clearEvents = useCallback(() => setEvents([]), []);

  const value = {
    env,
    switchEnv,
    isProdHost,
    connected,
    events,
    logs,
    clearLogs,
    clearEvents,
    chainsCache,
    setChainsCache,
    toast,
    toasts,
    reconnect,
    theme,
    toggleTheme,
    crawlActivity,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
      {!isAuthenticated && (
        <PinModal 
          onUnlock={() => {
            localStorage.setItem('atlas_auth', 'true');
            setIsAuthenticated(true);
          }} 
        />
      )}
    </AppContext.Provider>
  );
}
