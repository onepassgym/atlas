import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, XCircle, Trash2, Zap, AlertTriangle, CheckCircle } from 'lucide-react';
import Pagination from '../components/Pagination';
import Skeleton from '../components/Skeleton';
import JobDrawer from '../components/JobDrawer';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const LIMIT = 15;
const STATUS_FILTERS = [
  { value: '', label: 'All', icon: '' },
  { value: 'running', label: 'Running', icon: '🔄' },
  { value: 'queued', label: 'Queued', icon: '⏳' },
  { value: 'completed', label: 'Completed', icon: '✅' },
  { value: 'failed', label: 'Failed', icon: '❌' },
  { value: 'cancelled', label: 'Cancelled', icon: '🛑' },
];

function timeAgo(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) return 'just now';
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ${Math.round((diff % 3600000) / 60000)}m ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
}

export default function JobsPanel() {
  const { toast, events } = useApp();
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('running');
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState(null);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedJobs, setSelectedJobs] = useState([]);

  const fetchJobs = useCallback(async (p = page) => {
    setLoading(true);
    const params = new URLSearchParams({ limit: LIMIT, page: p });
    if (filter) params.set('status', filter);
    try {
      const res = await api.get(`/api/crawl/jobs?${params}`);
      if (res?.success) {
        setJobs(res.jobs || []);
        setTotal(res.total || 0);
        setPage(res.page || p);
      }
    } catch {} finally { setLoading(false); }
  }, [filter, page]);

  useEffect(() => { fetchJobs(1); }, [filter]);

  // Refresh on relevant SSE events
  useEffect(() => {
    if (events.length > 0 && events[0]?.type?.startsWith('job:') && events[0]?.type !== 'job:progress') {
      setTimeout(() => fetchJobs(page), 500);
    }
  }, [events]);

  const cancelJob = async (jobId, e) => {
    e?.stopPropagation();
    if (!(await confirm('Cancel this job?'))) return;
    try {
      await api.post(`/api/crawl/cancel/${jobId}`);
      toast('Job cancelled', 'info');
      setTimeout(() => fetchJobs(page), 500);
    } catch { toast('Failed', 'error'); }
  };

  const deleteJob = async (jobId, e) => {
    e?.stopPropagation();
    try {
      await api.delete(`/api/crawl/jobs/${jobId}`);
      toast('Job deleted', 'info');
      setTimeout(() => fetchJobs(page), 500);
    } catch { toast('Failed', 'error'); }
  };

  const retryFailed = async () => {
    try {
      const res = await api.post('/api/crawl/retry/failed');
      toast(res?.message || 'Retrying', 'success');
      setTimeout(() => fetchJobs(1), 1000);
    } catch { toast('Failed', 'error'); }
  };

  const clearQueue = async () => {
    if (!(await confirm('⚠️ Cancel ALL queued and running jobs?'))) return;
    try {
      const res = await api.post('/api/crawl/queue/clear');
      toast(res?.message || 'Cleared', 'info');
      setTimeout(() => fetchJobs(1), 500);
    } catch { toast('Failed', 'error'); }
  };

  const clearHistory = async () => {
    if (!(await confirm('🗑 Delete ALL non-active historical jobs?'))) return;
    try {
      const res = await api.post('/api/crawl/jobs/clear-history');
      toast(res?.message || 'History cleared', 'info');
      setTimeout(() => fetchJobs(1), 500);
    } catch { toast('Failed', 'error'); }
  };

  const bulkDelete = async () => {
    if (selectedJobs.length === 0) return;
    if (!(await confirm(`Delete ${selectedJobs.length} selected jobs?`))) return;
    try {
      const res = await api.post('/api/crawl/jobs/bulk-delete', { jobIds: selectedJobs });
      toast(res?.message || 'Jobs deleted', 'info');
      setSelectedJobs([]);
      setTimeout(() => fetchJobs(page), 500);
    } catch { toast('Failed', 'error'); }
  };

  const toggleSelectAll = (e) => {
    if (e.target.checked) setSelectedJobs(jobs.map(j => j.jobId));
    else setSelectedJobs([]);
  };

  const toggleSelectJob = (id) => {
    setSelectedJobs(prev => prev.includes(id) ? prev.filter(jId => jId !== id) : [...prev, id]);
  };

  const forceComplete = async (jobId, e) => {
    e?.stopPropagation();
    if (!(await confirm('🏁 Force complete this job? Current progress will be saved as final.'))) return;
    try {
      await api.post(`/api/crawl/force-complete/${jobId}`);
      toast('Job force-completed', 'success');
      setTimeout(() => fetchJobs(page), 500);
    } catch { toast('Failed', 'error'); }
  };

  const startNow = async (jobId, e) => {
    e?.stopPropagation();
    if (!(await confirm('⚡ Promote this job to run immediately?'))) return;
    setPromoting(jobId);
    try {
      const res = await api.post(`/api/crawl/start-now/${jobId}`);
      if (res?.promoted) {
        toast('Job promoted to front of queue!', 'success');
      } else {
        toast(res?.message || 'Action taken', 'info');
      }
      setTimeout(() => fetchJobs(page), 500);
    } catch { toast('Failed to promote job', 'error'); }
    finally { setPromoting(null); }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Filter Bar ────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="section-title" style={{ marginBottom: 0, flexShrink: 0 }}>Job History</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: '1 1 auto' }}>
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              className={`btn sm ${filter === f.value ? 'primary' : ''}`}
              onClick={() => { setFilter(f.value); setPage(1); }}
            >
              {f.icon} {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {selectedJobs.length > 0 && (
            <button className="btn sm danger" onClick={bulkDelete}><Trash2 size={12} /> Delete Selected ({selectedJobs.length})</button>
          )}
          <button className="btn sm" onClick={retryFailed}><RefreshCw size={12} /> Retry</button>
          <button className="btn sm secondary" onClick={clearHistory}><Trash2 size={12} /> Clear History</button>
          <button className="btn sm danger" onClick={clearQueue}><XCircle size={12} /> Clear Queue</button>
        </div>
      </div>

      {/* ── Jobs Table ────── */}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-responsive">
          <table className="data-table" id="jobs-table">
            <thead>
            <tr>
              <th style={{ width: 40 }}><input type="checkbox" onChange={toggleSelectAll} checked={jobs.length > 0 && selectedJobs.length === jobs.length} /></th>
              <th>Type</th><th>Name</th><th>Status</th><th>Progress</th>
              <th className="col-hide-mobile">Batches</th><th>New</th><th className="col-hide-mobile">Updated</th><th>Failed</th><th className="col-hide-mobile">Errors</th><th className="col-hide-mobile">Duration</th><th className="col-hide-mobile">When</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={12}><Skeleton count={5} height={32} /></td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={12} className="empty-state">No jobs found</td></tr>
            ) : jobs.map(j => {
              const p = j.progress || {};
              const total = p.total || 0;
              const pct = total > 0 ? Math.min(100, Math.round(((p.scraped || 0) + (p.failed || 0) + (p.skipped || 0)) / total * 100)) : 0;
              const name = j.input?.cityName || j.input?.gymName || j.input?.chainName || 'Unknown';
              const errorCount = j.errorCount || (j.jobErrors?.length) || 0;
              const hasBatches = p.batches > 0;
              return (
                <tr
                  key={j.jobId}
                  onClick={() => setSelectedJobId(j.jobId)}
                  style={{ cursor: 'pointer' }}
                  className={selectedJobs.includes(j.jobId) ? "job-row-clickable selected" : "job-row-clickable"}
                >
                  <td onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedJobs.includes(j.jobId)} onChange={() => toggleSelectJob(j.jobId)} />
                  </td>
                  <td><span className={`badge-type ${j.type || 'city'}`}>{j.type || 'city'}</span></td>
                  <td style={{ color: 'var(--text-primary)', fontWeight: 500, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</td>
                  <td><span className={`badge-status ${j.status}`}>{j.status}</span></td>
                  <td style={{ minWidth: 110 }}>
                    <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{pct}% ({total})</span>
                  </td>
                  <td className="col-hide-mobile" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {hasBatches ? (
                      <span style={{ color: (p.batchesDone || 0) >= p.batches ? 'var(--success)' : 'var(--accent)' }}>
                        {p.batchesDone || 0}/{p.batches}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ color: 'var(--success)', fontFamily: 'var(--mono)' }}>{p.newSpaces || 0}</td>
                  <td className="col-hide-mobile" style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{p.updatedSpaces || 0}</td>
                  <td style={{ color: 'var(--danger)', fontFamily: 'var(--mono)' }}>{p.failed || 0}</td>
                  <td className="col-hide-mobile">
                    {errorCount > 0 ? (
                      <span className="error-badge">{errorCount}</span>
                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td className="col-hide-mobile" style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)', fontSize: 12 }}>{fmtDuration(j.durationMs)}</td>
                  <td className="col-hide-mobile" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {timeAgo(j.completedAt || j.startedAt || j.createdAt)}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    {j.status === 'queued' && (
                      <button
                        className="btn sm accent"
                        onClick={(e) => startNow(j.jobId, e)}
                        disabled={promoting === j.jobId}
                        title="Start immediately"
                        style={{ marginRight: 4 }}
                      >
                        {promoting === j.jobId ? <RefreshCw size={12} className="spin" /> : <Zap size={12} />}
                      </button>
                    )}
                    {j.status === 'running' && (
                      <button 
                        className="btn sm success" 
                        onClick={(e) => forceComplete(j.jobId, e)} 
                        title="Force Complete"
                        style={{ marginRight: 4 }}
                      >
                        <CheckCircle size={12} />
                      </button>
                    )}
                    {(j.status === 'running' || j.status === 'queued') && (
                      <button className="btn sm danger" onClick={(e) => cancelJob(j.jobId, e)} title="Cancel"><XCircle size={12} /></button>
                    )}
                    {(j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') && (
                      <button className="btn sm danger" onClick={(e) => deleteJob(j.jobId, e)} title="Delete"><Trash2 size={12} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <Pagination current={page} total={totalPages} onPage={p => fetchJobs(p)} />
        </div>
      </div>

      {/* Job Detail Drawer */}
      {selectedJobId && <JobDrawer jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />}
    </div>
  );
}
