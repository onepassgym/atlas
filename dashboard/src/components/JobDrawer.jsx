import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Clock, AlertTriangle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import Skeleton from './Skeleton';

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

export default function JobDrawer({ jobId, onClose }) {
  const { events } = useApp();
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    api.get(`/api/crawl/status/${jobId}`)
      .then(res => { if (res?.job) setJob(res.job); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [jobId]);

  // Auto-refresh on job events
  useEffect(() => {
    if (!jobId || !events.length) return;
    const latest = events[0];
    if (latest?.data?.jobId === jobId && latest?.type?.startsWith('job:')) {
      api.get(`/api/crawl/status/${jobId}`)
        .then(res => { if (res?.job) setJob(res.job); })
        .catch(() => {});
    }
  }, [events, jobId]);

  if (!jobId) return null;

  const p = job?.progress || {};
  const total = p.total || 0;
  const scraped = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
  const pct = total > 0 ? Math.min(100, Math.round((scraped / total) * 100)) : 0;
  const errors = job?.jobErrors || [];
  const name = job?.input?.cityName || job?.input?.gymName || job?.input?.chainName || 'Unknown';

  // Filter job-related events from SSE history
  const jobEvents = events.filter(e => e.data?.jobId === jobId).slice(0, 30);

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <motion.div
        className="drawer"
        initial={{ x: 500 }}
        animate={{ x: 0 }}
        exit={{ x: 500 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      >
        {/* Header */}
        <div className="drawer-header">
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              {job?.jobId?.slice(0, 8) || '...'} · {job?.type || 'city'}
            </div>
          </div>
          <button className="btn sm" onClick={onClose} style={{ padding: 6 }}><X size={16} /></button>
        </div>

        {loading ? (
          <div className="drawer-body"><Skeleton count={6} height={32} /></div>
        ) : !job ? (
          <div className="drawer-body"><div className="empty-state">Job not found</div></div>
        ) : (
          <div className="drawer-body">
            {/* Status + Progress */}
            <div className="drawer-section">
              <div className="drawer-section-title">Status</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className={`badge-status ${job.status}`} style={{ fontSize: 12 }}>{job.status}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtDuration(job.durationMs)}</span>
                </div>
                {job.status === 'running' && (
                  <button 
                    className="btn sm success" 
                    onClick={async () => {
                      if (!confirm('🏁 Force complete?')) return;
                      await api.post(`/api/crawl/force-complete/${jobId}`);
                      onClose();
                    }}
                  >
                    <CheckCircle size={12} style={{ marginRight: 4 }} /> Force Complete
                  </button>
                )}
              </div>
              {total > 0 && (
                <>
                  <div className="progress-bar" style={{ height: 8, marginBottom: 6 }}>
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                    {scraped}/{total} processed ({pct}%)
                  </div>
                </>
              )}
              {p.batches > 0 && (
                <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' }}>
                  📦 Batches: {p.batchesDone || 0}/{p.batches} done
                </div>
              )}
            </div>

            {/* Stats Grid */}
            <div className="drawer-section">
              <div className="drawer-section-title">Results</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                {[
                  { label: 'New', value: p.newSpaces || 0, color: 'var(--success)', icon: <CheckCircle size={14} /> },
                  { label: 'Updated', value: p.updatedSpaces || 0, color: 'var(--accent)', icon: <RefreshCw size={14} /> },
                  { label: 'Failed', value: p.failed || 0, color: 'var(--danger)', icon: <XCircle size={14} /> },
                  { label: 'Skipped', value: p.skipped || 0, color: 'var(--text-muted)', icon: <Clock size={14} /> },
                ].map(s => (
                  <div key={s.label} style={{
                    textAlign: 'center', padding: '10px 4px', borderRadius: 8,
                    background: 'var(--bg-surface)', border: '1px solid var(--table-border)',
                  }}>
                    <div style={{ color: s.color, marginBottom: 2 }}>{s.icon}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Timestamps */}
            <div className="drawer-section">
              <div className="drawer-section-title">Timeline</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {[
                  { label: 'Created', time: job.createdAt },
                  { label: 'Started', time: job.startedAt },
                  { label: 'Completed', time: job.completedAt },
                ].map(t => (
                  <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--table-border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t.label}</span>
                    <div>
                      <span>{fmtDate(t.time)}</span>
                      {t.time && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{timeAgo(t.time)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Errors */}
            {errors.length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title" style={{ color: 'var(--danger)' }}>
                  <AlertTriangle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                  Errors ({errors.length})
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto', scrollbarWidth: 'thin' }}>
                  {errors.slice(0, 20).map((err, i) => (
                    <div key={i} style={{
                      padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                      background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)',
                      fontSize: 11, fontFamily: 'var(--mono)',
                    }}>
                      <div style={{ color: 'var(--danger)', marginBottom: 2 }}>{err.message?.slice(0, 100)}</div>
                      {err.url && <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>URL: {err.url.slice(-50)}</div>}
                      {err.at && <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{fmtDate(err.at)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Live Events */}
            {jobEvents.length > 0 && (
              <div className="drawer-section">
                <div className="drawer-section-title">Live Events ({jobEvents.length})</div>
                <div style={{ maxHeight: 200, overflowY: 'auto', scrollbarWidth: 'thin' }}>
                  {jobEvents.map((e, i) => (
                    <div key={`${e.timestamp}-${i}`} style={{
                      display: 'flex', gap: 8, padding: '4px 0',
                      borderBottom: '1px solid var(--table-border)', fontSize: 11,
                    }}>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)', minWidth: 55, fontSize: 10 }}>
                        {new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {e.type.replace('crawl:', '').replace('job:', '')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </>
  );
}
