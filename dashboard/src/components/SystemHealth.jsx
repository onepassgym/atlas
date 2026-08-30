import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

export default function SystemHealth() {
  const [health, setHealth] = useState({});

  const fetchHealth = useCallback(async () => {
    try {
      const [evtRes, qRes, cqRes] = await Promise.all([
        api.get('/api/events/stats').catch(() => ({})),
        api.get('/api/crawl/queue/stats').catch(() => ({ queue: {} })),
        api.get('/api/chains/crawl/queue-stats').catch(() => ({ queue: {} }))
      ]);
      setHealth({
        sseClients: evtRes?.sseClients || 0,
        totalEvents: evtRes?.totalEvents || 0,
        qActive: qRes?.queue?.active || 0,
        qWaiting: qRes?.queue?.waiting || 0,
        chainQ: `${cqRes?.queue?.active || 0}/${cqRes?.queue?.waiting || 0}`,
      });
    } catch {}
  }, []);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  return (
    <div className="card">
      <div className="card-header"><span className="card-title">System Health</span><span className="card-icon">💚</span></div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)' }}>
        <span>SSE Clients: <strong>{health.sseClients ?? '—'}</strong></span>
        <span>Events (buffer): <strong>{health.totalEvents ?? '—'}</strong></span>
        <span>Queue Active: <strong>{health.qActive ?? '—'}</strong></span>
        <span>Queue Waiting: <strong>{health.qWaiting ?? '—'}</strong></span>
        <span>Chain Queue: <strong>{health.chainQ ?? '—'}</strong></span>
      </div>
    </div>
  );
}
