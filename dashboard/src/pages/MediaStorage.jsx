'use strict';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDrive, FileImage, RefreshCw, AlertCircle, Search, Grid, List, X,
  Copy, Trash2, CheckSquare, Square, Tag, Eye, Download, Zap, LayoutGrid,
  Link2, Upload, RotateCcw, TrendingUp, Database, Unlink
} from 'lucide-react';
import { api, getBaseUrl, getProxyUrl } from '../api/client';

/* ── utils ──────────────────────────────────────────────────────────────────── */
function fmtBytes(b, d = 1) {
  if (!+b) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${parseFloat((b / k ** i).toFixed(d))} ${s[i]}`;
}
function copyText(t) { navigator.clipboard?.writeText(t).catch(() => {}); }
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  const bg = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#f59e0b';
  Object.assign(el.style, {
    position:'fixed', bottom:'24px', right:'24px', zIndex:9999,
    padding:'10px 18px', background:bg, color:'#fff', borderRadius:8,
    fontSize:13, fontWeight:600, boxShadow:'0 4px 20px rgba(0,0,0,.4)',
    transition:'opacity .3s', opacity:1,
  });
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, 3200);
}

const LIMIT = 60;
const TYPE_OPTS = [null, 'photo', 'cover', 'thumbnail', 'video'];
const SORT_OPTS = [['date','Newest'],['name','Name'],['size','Size'],['appeal','Appeal']];

/* ── StatCard ──────────────────────────────────────────────────────────────── */
function StatCard({ label, value, icon: Icon, color = '#10b981', sub, warn }) {
  return (
    <div style={{ background:'var(--bg-card)', border:`1px solid ${warn ? 'rgba(239,68,68,.4)' : 'var(--border)'}`, borderRadius:10, padding:'14px 18px', display:'flex', gap:12, alignItems:'center' }}>
      <div style={{ padding:10, background:`${color}18`, borderRadius:8, flexShrink:0 }}><Icon size={20} color={color}/></div>
      <div style={{ minWidth:0 }}>
        <div style={{ fontSize:10, color:'var(--text-muted)', fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>{label}</div>
        <div style={{ fontSize:19, fontWeight:900, fontFamily:'var(--mono)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{value}</div>
        {sub && <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ── MigrationBanner ─────────────────────────────────────────────────────────── */
function MigrationBanner({ stats, onMigrate, onSync, migrating, syncing }) {
  if (!stats?.needsMigration) return null;
  const diff = (stats.spacePhotoSum || 0) - (stats.totalCount || 0);
  return (
    <motion.div initial={{ opacity:0, y:-8 }} animate={{ opacity:1, y:0 }}
      style={{ padding:'14px 20px', background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.4)', borderRadius:10, display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <AlertCircle size={18} color="#f59e0b"/>
        <div>
          <div style={{ fontWeight:700, fontSize:13, color:'#f59e0b' }}>⚠ Media Sync Required</div>
          <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
            DB has <strong style={{ color:'var(--text-primary)' }}>{(stats.totalCount||0).toLocaleString()}</strong> records but spaces reference <strong style={{ color:'#f59e0b' }}>{(stats.spacePhotoSum||0).toLocaleString()}</strong> photos ({diff.toLocaleString()} missing). Run Migration to populate.
          </div>
        </div>
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={onMigrate} disabled={migrating}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'rgba(245,158,11,.15)', border:'1px solid rgba(245,158,11,.5)', borderRadius:7, color:'#f59e0b', cursor:'pointer', fontWeight:700, fontSize:12, opacity: migrating?.6:1 }}>
          <Database size={13}/> {migrating ? 'Migrating…' : 'Migrate from Spaces'}
        </button>
        <button onClick={onSync} disabled={syncing}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'rgba(16,185,129,.1)', border:'1px solid rgba(16,185,129,.4)', borderRadius:7, color:'#10b981', cursor:'pointer', fontWeight:700, fontSize:12, opacity: syncing?.6:1 }}>
          <RefreshCw size={13}/> {syncing ? 'Syncing…' : 'FS Sync'}
        </button>
      </div>
    </motion.div>
  );
}

/* ── PhotoCard (grid) ────────────────────────────────────────────────────────── */
function PhotoCard({ photo, selected, onSelect, onClick, base }) {
  const src = photo.thumbnailUrl || photo.publicUrl || photo.originalUrl || '';
  const url = src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`;
  return (
    <motion.div layout initial={{ opacity:0, scale:.95 }} animate={{ opacity:1, scale:1 }}
      style={{ borderRadius:8, overflow:'hidden', border: selected ? '2px solid var(--accent)' : '1px solid var(--border)', cursor:'pointer', background:'rgba(0,0,0,.3)', position:'relative' }}
      whileHover={{ scale:1.02, transition:{ duration:.1 } }}>
      <div onClick={e => { e.stopPropagation(); onSelect(photo._id); }}
        style={{ position:'absolute', top:6, left:6, zIndex:2 }}>
        {selected ? <CheckSquare size={16} color="var(--accent)"/> : <Square size={16} color="rgba(255,255,255,.45)"/>}
      </div>
      {photo.spaceId?.name && (
        <div style={{ position:'absolute', top:6, right:6, zIndex:2, background:'rgba(0,0,0,.6)', borderRadius:3, padding:'1px 6px', fontSize:8, color:'#fff', maxWidth:80, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {photo.spaceId.name}
        </div>
      )}
      <div onClick={() => onClick(photo)} style={{ aspectRatio:'4/3', background:'rgba(0,0,0,.2)' }}>
        {url
          ? <img src={url} alt={photo.filename || ''} loading="lazy" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={e => { e.target.style.display='none'; }}/>
          : <FileImage size={28} style={{ opacity:.15, margin:'auto', display:'block', paddingTop:30 }}/>
        }
      </div>
      <div style={{ padding:'6px 8px' }}>
        <div style={{ fontSize:10, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', color:'var(--text-primary)' }}>
          {photo.filename || photo._id}
        </div>
        <div style={{ fontSize:9, color:'var(--text-muted)', fontFamily:'var(--mono)', display:'flex', justifyContent:'space-between', marginTop:1 }}>
          <span>{fmtBytes(photo.sizeBytes || 0)}</span>
          <span style={{ background:'rgba(255,255,255,.08)', borderRadius:2, padding:'0 4px', textTransform:'uppercase', fontSize:8 }}>{photo.type || 'photo'}</span>
        </div>
      </div>
    </motion.div>
  );
}

/* ── MasonryCard ─────────────────────────────────────────────────────────────── */
function MasonryGrid({ photos, selected, onSelect, onClick, base }) {
  // 4-column masonry using CSS columns
  return (
    <div style={{ columns: 'auto 180px', columnGap: 10 }}>
      {photos.map(p => {
        const src = p.thumbnailUrl || p.publicUrl || p.originalUrl || '';
        const origUrl = src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`;
        const proxyUrl = getProxyUrl(p.proxyUrl || origUrl);
        const isSelected = selected.has(p._id);
        return (
          <div key={p._id} style={{ breakInside:'avoid', marginBottom:10, borderRadius:8, overflow:'hidden', border: isSelected ? '2px solid var(--accent)' : '1px solid var(--border)', cursor:'pointer', position:'relative' }}>
            <div onClick={e => { e.stopPropagation(); onSelect(p._id); }}
              style={{ position:'absolute', top:5, left:5, zIndex:2 }}>
              {isSelected ? <CheckSquare size={14} color="var(--accent)"/> : <Square size={14} color="rgba(255,255,255,.45)"/>}
            </div>
            {proxyUrl
              ? <img src={proxyUrl} alt={p.filename || ''} loading="lazy" onClick={() => onClick(p)} style={{ width:'100%', display:'block' }} onError={e => { e.target.style.display='none'; }}/>
              : <div style={{ height:100, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,.2)' }}><FileImage size={24} style={{ opacity:.15 }}/></div>
            }
          </div>
        );
      })}
    </div>
  );
}

/* ── Lightbox ────────────────────────────────────────────────────────────────── */
function Lightbox({ photo, onClose, base }) {
  const src = photo.originalUrl || photo.publicUrl || photo.url || '';
  const origUrl = src.startsWith('http') ? src : `${base}${src.startsWith('/') ? '' : '/'}${src}`;
  const proxyUrl = getProxyUrl(photo.proxyUrl || origUrl);
  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
      onClick={onClose}
      style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(0,0,0,.92)', display:'flex', alignItems:'center', justifyContent:'center', padding:24, backdropFilter:'blur(12px)' }}>
      <motion.div initial={{ scale:.88 }} animate={{ scale:1 }} exit={{ scale:.88 }}
        onClick={e => e.stopPropagation()}
        style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:14, maxWidth:900, width:'100%', overflow:'hidden' }}>
        <img src={proxyUrl} alt={photo.caption || ''} style={{ width:'100%', maxHeight:'66vh', objectFit:'contain', background:'#000', display:'block' }}/>
        <div style={{ padding:'14px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8 }}>
          <div>
            <div style={{ fontWeight:700, fontSize:14 }}>{photo.spaceId?.name || photo.filename || 'Unknown'}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2, fontFamily:'var(--mono)' }}>{photo.folder || ''}</div>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={() => { copyText(proxyUrl); toast('Proxy URL copied!', 'success'); }}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--accent)', border:'none', borderRadius:7, color:'#fff', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              <Copy size={13}/> Copy Proxy URL
            </button>
            <button onClick={() => { copyText(origUrl); toast('Original URL copied!', 'success'); }}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:7, color:'var(--text-primary)', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              <Link2 size={13}/> Copy Original URL
            </button>
            <a href={proxyUrl} download target="_blank" rel="noreferrer"
              style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:7, color:'var(--text-primary)', textDecoration:'none', fontWeight:600, fontSize:12 }}>
              <Download size={13}/> Download
            </a>
            <button onClick={onClose} style={{ padding:'7px 10px', background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.3)', borderRadius:7, color:'#ef4444', cursor:'pointer' }}>
              <X size={14}/>
            </button>
          </div>
        </div>
        <div style={{ padding:'0 20px 14px', display:'flex', gap:16, fontSize:11, color:'var(--text-muted)', fontFamily:'var(--mono)', flexWrap:'wrap' }}>
          {photo.sizeBytes  && <span>Size: {fmtBytes(photo.sizeBytes)}</span>}
          {photo.width      && <span>{photo.width}×{photo.height}px</span>}
          <span style={{ textTransform:'uppercase' }}>Type: {photo.type || 'photo'}</span>
          {photo.appealScore > 0 && <span>Appeal: {photo.appealScore.toFixed(1)}</span>}
          {photo.tags?.length > 0 && <span>Tags: {photo.tags.join(', ')}</span>}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   PROGRESS PANEL — shows live job status while migrate/sync is running
══════════════════════════════════════════════════════════════════════════════ */
const JOB_LABELS = { migrate: 'Migration', sync: 'FS Sync', relink: 'Relink Spaces' };
const JOB_COLORS = { migrate: '#f59e0b', sync: '#10b981', relink: '#8b5cf6' };

function ProgressPanel({ jobs }) {
  const active = Object.entries(jobs || {});
  if (!active.length) return null;
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {active.map(([key, job]) => {
        const pct   = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
        const color = JOB_COLORS[key] || '#3b82f6';
        const isDone  = job.status === 'done';
        const isError = job.status === 'error';
        return (
          <motion.div key={key}
            initial={{ opacity:0, y:-6 }} animate={{ opacity:1, y:0 }}
            style={{
              padding:'12px 18px',
              background: isError ? 'rgba(239,68,68,.07)' : `${color}0d`,
              border: `1px solid ${isError ? 'rgba(239,68,68,.4)' : color}44`,
              borderRadius:10,
            }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: pct !== null ? 8 : 0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                {!isDone && !isError && (
                  <span style={{ display:'inline-block', width:10, height:10, borderRadius:'50%', background:color, animation:'blink 1.2s ease-in-out infinite' }}/>
                )}
                {isDone  && <span style={{ color:'#10b981', fontSize:14 }}>✓</span>}
                {isError && <span style={{ color:'#ef4444', fontSize:14 }}>✗</span>}
                <span style={{ fontWeight:700, fontSize:12, color: isError ? '#ef4444' : color }}>{JOB_LABELS[key] || key}</span>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>{job.phase}</span>
              </div>
              <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                {job.upserted !== undefined && (
                  <span style={{ fontSize:11, fontFamily:'var(--mono)', color:'var(--text-muted)' }}>
                    {job.upserted.toLocaleString()} records
                  </span>
                )}
                {job.total > 0 && (
                  <span style={{ fontSize:11, fontFamily:'var(--mono)', color }}>
                    {job.done.toLocaleString()} / {job.total.toLocaleString()}
                    {pct !== null ? ` (${pct}%)` : ''}
                  </span>
                )}
                {isDone && job.finalCount !== undefined && (
                  <span style={{ fontSize:11, fontFamily:'var(--mono)', color:'#10b981', fontWeight:700 }}>
                    → {job.finalCount.toLocaleString()} total
                  </span>
                )}
              </div>
            </div>
            {pct !== null && (
              <div style={{ height:4, background:'rgba(255,255,255,.06)', borderRadius:4, overflow:'hidden' }}>
                <motion.div
                  animate={{ width: `${isDone ? 100 : pct}%` }}
                  transition={{ duration: 0.4, ease:'easeOut' }}
                  style={{ height:'100%', background: isError ? '#ef4444' : color, borderRadius:4 }}
                />
              </div>
            )}
            {pct === null && !isDone && !isError && (
              /* indeterminate bar */
              <div style={{ height:3, background:'rgba(255,255,255,.06)', borderRadius:4, overflow:'hidden', marginTop:8 }}>
                <div style={{ height:'100%', width:'40%', background:color, borderRadius:4, animation:'slide 1.4s ease-in-out infinite' }}/>
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════════════════════════════════════ */
export default function MediaStorage() {
  const [photos,      setPhotos]      = useState([]);
  const [stats,       setStats]       = useState(null);
  const [page,        setPage]        = useState(1);
  const [total,       setTotal]       = useState(0);
  const [totalPages,  setTotalPages]  = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,       setError]       = useState(null);
  const [search,      setSearch]      = useState('');
  const [typeFilter,  setTypeFilter]  = useState(null);
  const [sortBy,      setSortBy]      = useState('date');
  const [view,        setView]        = useState('grid');   // grid | list | masonry
  const [selected,    setSelected]    = useState(new Set());
  const [lightbox,    setLightbox]    = useState(null);
  const [migrating,   setMigrating]   = useState(false);
  const [syncing,     setSyncing]     = useState(false);
  const [actionMsg,   setActionMsg]   = useState('');
  const [jobs,        setJobs]        = useState({});   // live job progress
  const loaderRef  = useRef(null);
  const pollRef    = useRef(null);
  const base = getBaseUrl();

  /* ── progress polling ────────────────────────────────────────────────────── */
  const pollProgress = useCallback(async () => {
    try {
      const res = await api.get('/api/media/progress');
      if (res.success) {
        setJobs(res.jobs || {});
        // If a job just finished, refresh stats + media list
        const justDone = Object.values(res.jobs || {}).some(j => j.status === 'done');
        if (justDone) { fetchStats(); fetchPage(1, '', null, 'date'); }
      }
    } catch {}
  }, []);

  // Start/stop polling based on active jobs
  useEffect(() => {
    const hasActive = Object.values(jobs).some(j => j.status === 'running');
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(pollProgress, 1500);
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {};
  }, [jobs, pollProgress]);

  // Always poll once per 5s even when idle (catch externally-triggered jobs)
  // Clean up on unmount to prevent polling when user navigates away
  useEffect(() => {
    const t = setInterval(pollProgress, 5000);
    return () => {
      clearInterval(t);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [pollProgress]);

  /* ── fetch page ─────────────────────────────────────────────────────────── */
  const fetchPage = useCallback(async (pg, q, type, sort, append = false) => {
    try {
      if (pg === 1) setLoading(true); else setLoadingMore(true);
      setError(null);
      const p = new URLSearchParams({ page: pg, limit: LIMIT, sortBy: sort || 'date' });
      if (q)    p.set('search', q);
      if (type) p.set('type', type);
      const res = await api.get(`/api/media?${p}`);
      if (res.success) {
        setPhotos(prev => append ? [...prev, ...res.photos] : res.photos);
        setTotal(res.pagination.total);
        setTotalPages(res.pagination.pages);
      } else {
        setError(res.error || 'Failed to load media');
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); setLoadingMore(false); }
  }, []);

  /* ── fetch stats ─────────────────────────────────────────────────────────── */
  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get('/api/media/stats');
      if (res.success) setStats(res.stats);
    } catch {}
  }, []);

  useEffect(() => { fetchStats(); fetchPage(1, '', null, 'date'); pollProgress(); }, []);

  /* ── search debounce ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1); setSelected(new Set());
      fetchPage(1, search, typeFilter, sortBy);
    }, 420);
    return () => clearTimeout(t);
  }, [search, typeFilter, sortBy]);

  /* ── infinite scroll observer (ref-stable callback avoids re-creation) ───── */
  const scrollStateRef = useRef({ page, totalPages, loading, loadingMore, search, typeFilter, sortBy });
  scrollStateRef.current = { page, totalPages, loading, loadingMore, search, typeFilter, sortBy };

  useEffect(() => {
    if (!loaderRef.current) return;
    const obs = new IntersectionObserver(entries => {
      const { page: p, totalPages: tp, loadingMore: lm, loading: ld, search: s, typeFilter: tf, sortBy: sb } = scrollStateRef.current;
      if (entries[0].isIntersecting && p < tp && !lm && !ld) {
        const next = p + 1;
        setPage(next);
        fetchPage(next, s, tf, sb, true);
      }
    }, { threshold: 0.1 });
    obs.observe(loaderRef.current);
    return () => obs.disconnect();
  }, []); // stable — reads from ref

  /* ── keyboard shortcut: Escape clears selection ─────────────────────────── */
  useEffect(() => {
    const fn = e => { if (e.key === 'Escape') setSelected(new Set()); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  /* ── select helpers ─────────────────────────────────────────────────────── */
  const toggleSelect = id => setSelected(prev => {
    const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s;
  });
  const selectAll = () => setSelected(new Set(photos.map(p => p._id)));
  const clearSel  = () => setSelected(new Set());

  /* ── bulk delete ─────────────────────────────────────────────────────────── */
  const bulkDelete = async () => {
    if (!selected.size) return;
    if (!confirm(`Soft-delete ${selected.size} media items?`)) return;
    try {
      const r = await fetch(`${base}/api/media/bulk`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-api-key': localStorage.getItem('atlas_api_key') || '' },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await r.json();
      if (data.success) {
        setPhotos(p => p.filter(x => !selected.has(x._id)));
        setTotal(t => t - selected.size);
        toast(`Deleted ${selected.size} items`, 'success');
        clearSel();
      }
    } catch (e) { toast(e.message, 'error'); }
  };

  /* ── migrate from spaces ──────────────────────────────────────────────────── */
  const triggerMigrate = async () => {
    setMigrating(true); setActionMsg('');
    try {
      const res = await api.post('/api/media/migrate-from-spaces', {});
      setActionMsg(res.message || 'Migration started — refreshing in 15s…');
      toast('Migration started! Refreshing in 15s…', 'info');
      setTimeout(() => { fetchStats(); fetchPage(1, search, typeFilter, sortBy); setActionMsg(''); }, 15000);
    } catch (e) { toast(e.message, 'error'); }
    finally { setMigrating(false); }
  };

  /* ── filesystem sync ─────────────────────────────────────────────────────── */
  const triggerSync = async () => {
    setSyncing(true); setActionMsg('');
    try {
      const res = await api.post('/api/media/sync', {});
      setActionMsg(res.message || 'Sync started — refreshing in 20s…');
      toast('FS Sync started! Refreshing in 20s…', 'info');
      setTimeout(() => { fetchStats(); fetchPage(1, search, typeFilter, sortBy); setActionMsg(''); }, 20000);
    } catch (e) { toast(e.message, 'error'); }
    finally { setSyncing(false); }
  };

  /* ── relink spaces ─────────────────────────────────────────────────────────── */
  const triggerRelink = async () => {
    try {
      const res = await api.post('/api/media/relink-spaces', {});
      toast(res.message || 'Relink done', 'success');
      fetchStats();
    } catch (e) { toast(e.message, 'error'); }
  };

  const hasMore = page < totalPages;

  /* ═══════════════════════════════ RENDER ══════════════════════════════════ */
  return (
    <motion.div initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }}
      style={{ padding:24, display:'flex', flexDirection:'column', gap:18 }}>

      {/* ── Header ── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ padding:12, background:'rgba(16,185,129,.1)', borderRadius:12, border:'1px solid rgba(16,185,129,.25)' }}>
            <HardDrive size={26} color="#10b981"/>
          </div>
          <div>
            <h1 style={{ margin:0, fontSize:22, fontWeight:900, letterSpacing:-.5 }}>MEDIA VAULT</h1>
            <p style={{ margin:'3px 0 0', fontSize:12, color:'var(--text-muted)' }}>
              {total.toLocaleString()} indexed · {stats?.spacePhotoSum ? `${stats.spacePhotoSum.toLocaleString()} in spaces` : ''} · space_photos collection
            </p>
          </div>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {selected.size > 0 && (
            <button onClick={bulkDelete}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', background:'rgba(239,68,68,.1)', border:'1px solid rgba(239,68,68,.35)', borderRadius:8, color:'#ef4444', cursor:'pointer', fontWeight:600, fontSize:12 }}>
              <Trash2 size={13}/> Delete {selected.size}
            </button>
          )}
          <button onClick={triggerRelink} title="Link unlinked photos to spaces by folder slug"
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 12px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-muted)', cursor:'pointer', fontSize:12 }}>
            <Link2 size={13}/> Relink
          </button>
          <button onClick={triggerSync} disabled={syncing}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-primary)', cursor:'pointer', fontWeight:600, fontSize:12, opacity: syncing?.6:1 }}>
            <RefreshCw size={13} color="#10b981"/> {syncing ? 'Syncing…' : 'FS Sync'}
          </button>
          <button onClick={triggerMigrate} disabled={migrating}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 14px', background:'rgba(245,158,11,.1)', border:'1px solid rgba(245,158,11,.4)', borderRadius:8, color:'#f59e0b', cursor:'pointer', fontWeight:700, fontSize:12, opacity: migrating?.6:1 }}>
            <Database size={13}/> {migrating ? 'Migrating…' : 'Migrate'}
          </button>
          {/* View switcher */}
          <div style={{ display:'flex', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
            {[['grid',<Grid size={13}/>],['list',<List size={13}/>],['masonry',<LayoutGrid size={13}/>]].map(([v, icon]) => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding:'8px 11px', border:'none', borderRight:'1px solid var(--border)', background: view===v ? 'var(--accent)' : 'transparent', color: view===v ? '#fff' : 'var(--text-muted)', cursor:'pointer', display:'flex', alignItems:'center' }}>
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Migration Banner ── */}
      <MigrationBanner stats={stats} onMigrate={triggerMigrate} onSync={triggerSync} migrating={migrating} syncing={syncing}/>

      {/* ── Live job progress ── */}
      <ProgressPanel jobs={jobs}/>

      {actionMsg && !Object.keys(jobs).length && (
        <div style={{ padding:'10px 16px', background:'rgba(245,158,11,.08)', border:'1px solid rgba(245,158,11,.3)', borderRadius:8, fontSize:12, color:'#f59e0b' }}>
          ⚡ {actionMsg}
        </div>
      )}

      {/* ── Stats grid ── */}
      {stats && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(155px,1fr))', gap:10 }}>
          <StatCard label="Indexed Media"  value={(stats.totalCount||0).toLocaleString()}    icon={FileImage}    color="#10b981" sub="in space_photos"/>
          <StatCard label="Space Photos Sum" value={(stats.spacePhotoSum||0).toLocaleString()}   icon={TrendingUp}   color="#3b82f6" sub="from space docs" warn={stats.needsMigration}/>
          <StatCard label="Storage Used"   value={fmtBytes(stats.totalSize)}                 icon={HardDrive}    color="var(--accent)"/>
          <StatCard label="Missing Files"  value={(stats.missingCount||0).toLocaleString()}  icon={AlertCircle}  color="#ef4444" warn={stats.missingCount > 0}/>
          <StatCard label="Unlinked"       value={(stats.unlinkedCount||0).toLocaleString()} icon={Unlink}       color="#f97316"/>
          <StatCard label="Orphaned"       value={(stats.orphanedCount||0).toLocaleString()} icon={Tag}          color="#8b5cf6"/>
          <StatCard label="Added (7d)"     value={(stats.recentUploads||0).toLocaleString()} icon={RefreshCw}    color="#06b6d4"/>
        </div>
      )}

      {/* ── Search + Filters ── */}
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ flex:'1 1 260px', position:'relative' }}>
          <Search size={14} style={{ position:'absolute', left:11, top:'50%', transform:'translateY(-50%)', color:'var(--text-muted)', pointerEvents:'none' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search filename, space, folder, tags…"
            style={{ width:'100%', padding:'8px 12px 8px 34px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-primary)', fontSize:13, boxSizing:'border-box', outline:'none' }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:2 }}>
              <X size={13}/>
            </button>
          )}
        </div>

        {/* type filter chips */}
        <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
          {TYPE_OPTS.map(t => (
            <button key={t||'all'} onClick={() => { setTypeFilter(t); setPage(1); }}
              style={{ padding:'5px 12px', borderRadius:20, fontSize:11, fontWeight:600, cursor:'pointer',
                background: typeFilter===t ? 'var(--accent)' : 'var(--bg-card)',
                color:      typeFilter===t ? '#fff' : 'var(--text-muted)',
                border:     typeFilter===t ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
              {t ? t[0].toUpperCase()+t.slice(1) : 'All'}
            </button>
          ))}
        </div>

        {/* sort */}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          style={{ padding:'6px 10px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-primary)', fontSize:12, cursor:'pointer' }}>
          {SORT_OPTS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
        </select>

        {photos?.length > 0 && (
          <button onClick={selected.size === photos.length ? clearSel : selectAll}
            style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:8, color:'var(--text-muted)', cursor:'pointer', fontSize:11, whiteSpace:'nowrap' }}>
            {selected.size === photos.length ? <CheckSquare size={12}/> : <Square size={12}/>}
            {selected.size === photos.length ? 'Deselect All' : `Select All (${photos.length})`}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background:'rgba(239,68,68,.08)', border:'1px solid #ef4444', padding:14, borderRadius:8, color:'#ef4444', display:'flex', gap:10, alignItems:'center', fontSize:13 }}>
          <AlertCircle size={16}/>{error}
        </div>
      )}

      {/* ── Media Grid / List / Masonry ── */}
      <div style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:12, padding:16 }}>
        {loading ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:12 }}>
            {Array(12).fill(0).map((_,i) => (
              <div key={i} style={{ borderRadius:8, background:'var(--bg-hover)', aspectRatio:'4/3', animation:'pulse 1.5s ease-in-out infinite' }}/>
            ))}
          </div>
        ) : photos?.length === 0 ? (
          <div style={{ textAlign:'center', padding:'60px 20px', color:'var(--text-muted)' }}>
            <HardDrive size={48} style={{ opacity:.1, marginBottom:12 }}/>
            <div style={{ fontWeight:600 }}>No media found</div>
            <div style={{ fontSize:12, marginTop:6 }}>
              {total === 0
                ? 'Run "Migrate" to pull from space records, or "FS Sync" to index from filesystem.'
                : 'Try adjusting your search or filters.'}
            </div>
          </div>
        ) : view === 'masonry' ? (
          <MasonryGrid photos={photos} selected={selected} onSelect={toggleSelect} onClick={setLightbox} base={base}/>
        ) : view === 'grid' ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:12 }}>
            {photos?.map(p => (
              <PhotoCard key={p._id} photo={p} base={base}
                selected={selected.has(p._id)} onSelect={toggleSelect} onClick={setLightbox}/>
            ))}
          </div>
        ) : (
          /* ── List view ── */
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)', color:'var(--text-muted)', textAlign:'left' }}>
                <th style={{ padding:'6px 8px', width:28 }}><Square size={12}/></th>
                <th style={{ padding:'6px 8px' }}>File</th>
                <th style={{ padding:'6px 8px' }}>Space</th>
                <th style={{ padding:'6px 8px' }}>Type</th>
                <th style={{ padding:'6px 8px' }}>Size</th>
                <th style={{ padding:'6px 8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {photos?.map(p => {
                const src = p.publicUrl || p.originalUrl || '';
                const origUrl = src.startsWith('http') ? src : `${base}${src.startsWith('/')? '' :'/'}${src}`;
                const proxyUrl = getProxyUrl(p.proxyUrl || origUrl);
                return (
                  <tr key={p._id}
                    style={{ borderBottom:'1px solid rgba(255,255,255,.04)', transition:'background .1s' }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                    <td style={{ padding:'7px 8px' }}><input type="checkbox" checked={selected.has(p._id)} onChange={() => toggleSelect(p._id)} style={{ cursor:'pointer' }}/></td>
                    <td style={{ padding:'7px 8px', fontFamily:'var(--mono)', color:'var(--text-muted)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.filename || p._id}</td>
                    <td style={{ padding:'7px 8px', maxWidth:150, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.spaceId?.name || <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                    <td style={{ padding:'7px 8px' }}><span style={{ background:'rgba(255,255,255,.07)', borderRadius:3, padding:'2px 6px', fontSize:9, textTransform:'uppercase' }}>{p.type||'photo'}</span></td>
                    <td style={{ padding:'7px 8px', fontFamily:'var(--mono)', color:'var(--text-muted)', whiteSpace:'nowrap' }}>{fmtBytes(p.sizeBytes||0)}</td>
                    <td style={{ padding:'7px 8px' }}>
                      <div style={{ display:'flex', gap:5 }}>
                        <button onClick={() => setLightbox(p)} title="Preview" style={{ padding:'4px 8px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:5, cursor:'pointer', color:'var(--text-muted)' }}><Eye size={11}/></button>
                        <button onClick={() => { copyText(proxyUrl); toast('Proxy URL Copied!', 'success'); }} title="Copy Proxy URL" style={{ padding:'4px 8px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:5, cursor:'pointer', color:'var(--text-muted)' }}><Copy size={11}/></button>
                        <button onClick={() => { copyText(origUrl); toast('Original URL Copied!', 'success'); }} title="Copy Original URL" style={{ padding:'4px 8px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:5, cursor:'pointer', color:'var(--text-muted)' }}><Link2 size={11}/></button>
                        <a href={proxyUrl} download target="_blank" rel="noreferrer" style={{ padding:'4px 8px', background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:5, cursor:'pointer', color:'var(--text-muted)', display:'flex', alignItems:'center' }}><Download size={11}/></a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── Infinite scroll sentinel ── */}
        <div ref={loaderRef} style={{ height:1 }}/>
        {loadingMore && (
          <div style={{ textAlign:'center', padding:20, color:'var(--text-muted)', fontSize:12 }}>
            <RefreshCw size={14} style={{ display:'inline', marginRight:6, animation:'spin 1s linear infinite' }}/>
            Loading more…
          </div>
        )}
        {!loading && !loadingMore && photos?.length > 0 && (
          <div style={{ textAlign:'center', padding:'14px 0 4px', fontSize:11, color:'var(--text-muted)' }}>
            Showing {photos?.length?.toLocaleString()} of {total.toLocaleString()} · {hasMore ? `Scroll for more (pg ${page}/${totalPages})` : '✓ All loaded'}
          </div>
        )}
      </div>

      {/* ── Lightbox ── */}
      <AnimatePresence>
        {lightbox && <Lightbox photo={lightbox} onClose={() => setLightbox(null)} base={base}/>}
      </AnimatePresence>

      <style>{`
        @keyframes spin  { 100% { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:.4; } 50% { opacity:.8; } }
        @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:.2; } }
        @keyframes slide { 0% { transform:translateX(-100%); } 100% { transform:translateX(350%); } }
      `}</style>
    </motion.div>
  );
}
