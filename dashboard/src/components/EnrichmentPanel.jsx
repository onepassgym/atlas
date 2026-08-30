import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, RefreshCw, Zap, Clock, Database, ArrowRight, Activity } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

function timeAgo(date) {
  if (!date) return 'never';
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function EnrichmentPanel() {
  const { toast, events } = useApp();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get('/api/enrichment/status');
      if (res?.success) setStatus(res.enrichment);
    } catch {} finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Poll status every 10s
  useEffect(() => {
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Refresh on enrichment SSE events
  useEffect(() => {
    if (events.length > 0 && events[0]?.type?.startsWith('enrichment:')) {
      setTimeout(fetchStatus, 500);
    }
  }, [events, fetchStatus]);

  const handleToggle = async () => {
    setToggling(true);
    try {
      const res = await api.post('/api/enrichment/toggle');
      if (res?.success) {
        toast(res.message, res.paused ? 'info' : 'info');
        await fetchStatus();
      } else {
        toast(res?.error || 'Toggle failed', 'error');
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <div className="card enrichment-card" style={{ padding: 16 }}>
        <div style={{ height: 40, background: 'var(--shimmer-from)', borderRadius: 8, animation: 'shimmer 1.5s infinite' }} />
      </div>
    );
  }

  const isPaused = status?.paused ?? true;
  const state = status?.state || 'idle';
  const isRunning = state === 'running';
  const isIdle = state === 'idle' || state === 'stopped';

  const stateIcon = isRunning ? '⚡' : isPaused ? '⏸️' : isIdle ? '💤' : '🔄';
  const stateLabel = isPaused ? 'Paused' : isRunning ? 'Running' : isIdle ? 'Idle' : state;
  const stateColor = isRunning ? 'var(--success)' : isPaused ? 'var(--warning)' : 'var(--text-muted)';

  return (
    <motion.div
      className={`card enrichment-card ${isPaused ? 'paused' : ''}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{ 
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      {/* Header */}
      <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Database size={16} color="var(--accent)" /> Enrichment Engine</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              className={`status-indicator ${isRunning ? 'pulse' : ''}`}
              style={{ background: stateColor }}
            />
            <span style={{ fontSize: 12, fontWeight: 600, color: stateColor }}>
              {stateIcon} {stateLabel}
            </span>
          </div>
        </div>

        <button
          className={`enrich-toggle-btn ${isPaused ? 'paused' : 'running'} ${isRunning ? 'enrich-pulse' : ''}`}
          onClick={handleToggle}
          disabled={toggling}
          title={isPaused ? 'Resume enrichment' : 'Pause enrichment'}
        >
          {toggling ? (
            <RefreshCw size={14} className="spin" />
          ) : isPaused ? (
            <Play size={14} />
          ) : (
            <Pause size={14} />
          )}
          {isPaused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {/* Main Content Row */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
        {/* Left: Progress Gauge */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '0 10px' }}>
          <div style={{ position: 'relative', width: 80, height: 80 }}>
            <svg width="80" height="80" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" stroke="var(--border)" strokeWidth="8" />
              <motion.circle 
                cx="50" cy="50" r="45" fill="none" stroke="var(--success)" strokeWidth="8" 
                strokeDasharray="283"
                initial={{ strokeDashoffset: 283 }}
                animate={{ strokeDashoffset: 283 - (283 * Math.min(1, (status?.processedToday || 0) / 1000)) }}
                transition={{ duration: 1.5, ease: "easeOut" }}
                strokeLinecap="round"
                style={{ filter: 'drop-shadow(0 0 4px var(--success))' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>{status?.processedToday ?? 0}</span>
              <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Today</span>
            </div>
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Daily Goal: 1k</div>
        </div>

        {/* Right: Stats Grid & Sparkline */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <div className="enrich-stat" style={{ padding: '8px 4px' }}>
              <span className="enrich-stat-value" style={{ color: 'var(--accent)', fontSize: 16 }}>{status?.processedTotal ?? 0}</span>
              <span className="enrich-stat-label" style={{ fontSize: 9 }}>Total</span>
            </div>
            <div className="enrich-stat" style={{ padding: '8px 4px' }}>
              <span className="enrich-stat-value" style={{ color: 'var(--cyan)', fontSize: 16 }}>{status?.totalEligibleSpaces ?? 0}</span>
              <span className="enrich-stat-label" style={{ fontSize: 9 }}>Eligible</span>
            </div>
            <div className="enrich-stat" style={{ padding: '8px 4px' }}>
              <span className="enrich-stat-value" style={{ color: 'var(--warning)', fontSize: 16 }}>{status?.staleSpaces ?? 0}</span>
              <span className="enrich-stat-label" style={{ fontSize: 9 }}>Stale</span>
            </div>
            <div className="enrich-stat" style={{ padding: '8px 4px' }}>
              <span className="enrich-stat-value" style={{ color: 'var(--orange)', fontSize: 16 }}>{status?.priorityQueueLength ?? 0}</span>
              <span className="enrich-stat-label" style={{ fontSize: 9 }}>Priority</span>
            </div>
          </div>
          
          <div style={{ height: 40, width: '100%', background: 'var(--bg-surface)', borderRadius: 8, padding: '4px 12px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
             <Activity size={14} color="var(--success)" />
             <div style={{ flex: 1, height: 20, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
                   {Array.from({ length: 20 }).map((_, i) => (
                     <motion.div 
                       key={i}
                       initial={{ height: 0 }}
                       animate={{ height: `${20 + Math.random() * 80}%` }}
                       transition={{ repeat: Infinity, duration: 1 + Math.random(), repeatType: 'reverse' }}
                       style={{ flex: 1, background: 'var(--success)', opacity: 0.3, borderRadius: 1 }}
                     />
                   ))}
                </div>
             </div>
             <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)', fontFamily: 'var(--mono)' }}>REALTIME_STREAM</span>
          </div>
        </div>
      </div>

      {/* Current / Next info */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* Last enriched */}
        {status?.lastSpace && (
          <div className="enrich-next-space" style={{ flex: 1 }}>
            <span style={{ fontSize: 14 }}>✅</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>
                Last: {status.lastSpace}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                {status.lastAction} · {status.lastDuration ? `${(status.lastDuration / 1000).toFixed(1)}s` : '—'}
              </div>
            </div>
          </div>
        )}

        {/* Next in queue */}
        {status?.nextInQueue && (
          <div className="enrich-next-space" style={{ flex: 1 }}>
            <span style={{ fontSize: 14 }}>⏭️</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>
                Next: {status.nextInQueue.name}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                {status.nextInQueue.area} · Updated {timeAgo(status.nextInQueue.lastUpdated)}
              </div>
            </div>
          </div>
        )}

        {/* Priority queue preview */}
        {status?.priorityQueueLength > 0 && (
          <div className="enrich-next-space" style={{ flex: '1 1 100%', marginTop: 4, background: 'rgba(249, 115, 22, 0.05)', border: '1px solid rgba(249, 115, 22, 0.1)' }}>
            <Zap size={14} style={{ color: 'var(--orange)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--orange)', display: 'flex', justifyContent: 'space-between' }}>
                <span>PRIORITY QUEUE ACTIVE</span>
                <span>{status.priorityQueueLength} ITEMS</span>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {status.priorityQueue?.slice(0, 3).map(p => p.spaceName).filter(Boolean).join(', ') || 'Processing high-priority tasks'}
              </div>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
