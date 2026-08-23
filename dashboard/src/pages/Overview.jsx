import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, Sector } from 'recharts';
import { Building2, Camera, Zap, Target, Link2, Activity, TrendingUp, XCircle, RefreshCw } from 'lucide-react';
import EnrichmentPanel from '../components/EnrichmentPanel';
import HealthRecommendations from '../components/HealthRecommendations';
import Skeleton from '../components/Skeleton';
import GymRow from '../components/GymRow';
import GymDrawer from '../components/GymDrawer';
import SystemPanel from '../components/SystemPanel';
import JobsPanel from '../components/JobsPanel';
import ChainsPanel from '../components/ChainsPanel';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#f97316', '#ec4899'];

function formatCategory(cat) {
  if (!cat || cat === 'undefined' || cat === 'unknown') return 'Unknown';
  return String(cat).split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--tooltip-glass-bg)',
      backdropFilter: 'blur(16px)',
      border: '1px solid var(--card-glass-border)',
      borderRadius: 12,
      padding: '12px 16px',
      fontSize: 13,
      boxShadow: 'var(--shadow-lg)'
    }}>
      <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: payload[0].payload.fill || CHART_COLORS[0], boxShadow: `0 0 8px ${payload[0].payload.fill || CHART_COLORS[0]}` }} />
        {payload[0].payload.name || payload[0].payload._id}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--mono)' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 15 }}>{payload[0].value.toLocaleString()}</span> venues
      </div>
    </div>
  );
};

const renderActiveShape = (props) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, payload, value } = props;
  return (
    <g>
      <text x={cx} y={cy - 10} dy={8} textAnchor="middle" fill="var(--text-primary)" style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--mono)', textShadow: `0 0 12px ${fill}88` }}>
        {value.toLocaleString()}
      </text>
      <text x={cx} y={cy + 14} dy={8} textAnchor="middle" fill="var(--text-muted)" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>
        {payload.name}
      </text>
      <Sector cx={cx} cy={cy} innerRadius={innerRadius} outerRadius={outerRadius + 8} startAngle={startAngle} endAngle={endAngle} fill={fill} filter="url(#glow)" />
      <Sector cx={cx} cy={cy} innerRadius={innerRadius} outerRadius={outerRadius + 2} startAngle={startAngle} endAngle={endAngle} fill={fill} />
    </g>
  );
};

export default function Overview() {
  const { events, setChainsCache, toast } = useApp();
  const [stats, setStats] = useState(null);
  const [queueStats, setQueueStats] = useState(null);
  const [mediaQueueStats, setMediaQueueStats] = useState(null);
  const [chainStats, setChainStats] = useState({ count: 0, totalLocs: 0 });
  const [latestGyms, setLatestGyms] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [selectedGym, setSelectedGym] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isGlobalPaused, setIsGlobalPaused] = useState(false);
  const [crawlPace, setCrawlPace] = useState('normal');
  const [isMediaPaused, setIsMediaPaused] = useState(false);
  const [isCrawlQueuePaused, setIsCrawlQueuePaused] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [gymRes, queueRes, chainRes, latestRes, jobsRes, stateRes, queuePausedRes] = await Promise.all([
        api.get('/api/spaces/stats').catch(() => null),
        api.get('/api/crawl/queue/stats').catch(() => null),
        api.get('/api/chains').catch(() => ({ chains: [] })),
        api.get('/api/spaces?limit=6&sortBy=createdAt').catch(() => null),
        api.get('/api/crawl/jobs?limit=6').catch(() => null),
        api.get('/api/system/state').catch(() => ({ state: {} })),
        api.get('/api/crawl/queue/paused').catch(() => null),
      ]);

      if (stateRes?.state?.globalPause !== undefined) setIsGlobalPaused(stateRes.state.globalPause);
      if (stateRes?.state?.crawlPace !== undefined) setCrawlPace(stateRes.state.crawlPace);
      if (stateRes?.state?.mediaQueuePaused !== undefined) setIsMediaPaused(stateRes.state.mediaQueuePaused);
      if (queuePausedRes?.success) setIsCrawlQueuePaused(queuePausedRes.crawlPaused || false);
      
      if (gymRes?.success) setStats(gymRes.stats);
      if (queueRes?.success) {
        setQueueStats(queueRes.queue);
        setMediaQueueStats(queueRes.mediaQueue);
      }
      if (chainRes?.chains) {
        setChainsCache(chainRes.chains);
        const totalLocs = chainRes.chains.reduce((s, c) => s + (c.totalLocations || 0), 0);
        setChainStats({ count: chainRes.chains.length, totalLocs });
      }
      if (latestRes?.success) setLatestGyms(latestRes.spaces || []);
      if (jobsRes?.success) setJobs(jobsRes.jobs || []);
    } catch {} finally {
      setLoading(false);
    }
  }, [setChainsCache]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Debounced refresh based on real-time SSE events — prevents API storm during active crawl
  useEffect(() => {
    if (events.length === 0) return;
    
    const latest = events[0];
    const type = latest?.type || '';
    
    // Determine what to refetch based on event type
    let refetchJobs = false;
    let refetchGyms = false;
    
    if (type.startsWith('job:') && type !== 'job:progress') refetchJobs = true;
    if (type === 'gym:created' || type === 'gym:updated') refetchGyms = true;
    
    if (!refetchJobs && !refetchGyms) return;
    
    // Debounce: wait 2s after last relevant event before refetching
    const timer = setTimeout(() => {
      if (refetchJobs) {
        api.get('/api/crawl/jobs?limit=6').then(r => r?.success && setJobs(r.jobs || [])).catch(() => {});
      }
      if (refetchGyms) {
        api.get('/api/spaces/stats').then(r => r?.success && setStats(r.stats)).catch(() => {});
        api.get('/api/spaces?limit=6&sortBy=createdAt').then(r => r?.success && setLatestGyms(r.spaces || [])).catch(() => {});
      }
    }, 2000);
    
    return () => clearTimeout(timer);
  }, [events]);

  if (loading) return <div className="container"><Skeleton height={100} count={3} /></div>;

  const toggleGlobalPause = async () => {
    try {
      const res = await api.post('/api/system/global-pause', { paused: !isGlobalPaused });
      setIsGlobalPaused(!isGlobalPaused);
      if (toast) toast(res?.message || (isGlobalPaused ? 'System Resumed' : 'System Standby Activated'), isGlobalPaused ? 'success' : 'warning');
    } catch { if (toast) toast('Failed to update system state', 'error'); }
  };

  const changePace = async (e) => {
    const pace = e.target.value;
    try {
      const res = await api.post('/api/system/pace', { pace });
      setCrawlPace(pace);
      if (toast) toast(res?.message || 'Pace updated', 'info');
    } catch { if (toast) toast('Failed to update pace', 'error'); }
  };

  const toggleMediaPause = async () => {
    try {
      if (isMediaPaused) {
        const res = await api.post('/api/system/media/queue/resume');
        setIsMediaPaused(false);
        if (toast) toast(res?.message || 'Media downloading resumed', 'success');
      } else {
        const res = await api.post('/api/system/media/queue/pause');
        setIsMediaPaused(true);
        if (toast) toast(res?.message || 'Media downloading paused', 'warning');
      }
    } catch { if (toast) toast('Failed to update media state', 'error'); }
  };

  const resumeCrawlQueue = async () => {
    try {
      const res = await api.post('/api/crawl/queue/resume');
      setIsCrawlQueuePaused(false);
      if (toast) toast(res?.message || 'Crawl queue resumed', 'success');
    } catch { if (toast) toast('Failed to resume crawl queue', 'error'); }
  };

  const cityData = (stats?.topCities || []).map(c => ({ name: c._id || 'Unknown', count: c.count }));
  const catData = (stats?.byCategory || []).slice(0, 8).map(c => ({ name: formatCategory(c._id), value: c.count }));

  return (
    <motion.div className="container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {/* ── Command Center Header ────── */}
      <div style={{
        background: 'var(--header-glass-bg)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-glow)',
        borderRadius: 16,
        padding: 'var(--card-py) var(--card-px)',
        marginBottom: 'var(--spacing-lg)',
        boxShadow: 'var(--shadow)',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--spacing-lg)',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        {/* Decorative Grid Background */}
        <div style={{ position: 'absolute', inset: 0, opacity: 0.1, backgroundImage: 'linear-gradient(var(--text-muted) 1px, transparent 1px), linear-gradient(90deg, var(--text-muted) 1px, transparent 1px)', backgroundSize: '20px 20px', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--accent), transparent)' }} />
        
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ 
            padding: 16, 
            background: 'rgba(139, 92, 246, 0.1)', 
            borderRadius: 16, 
            border: '1px solid rgba(139, 92, 246, 0.3)',
            boxShadow: '0 0 24px rgba(139, 92, 246, 0.15)',
            flexShrink: 0
          }}>
            <Target size={32} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 8px rgba(167, 139, 250, 0.4))' }} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ 
              fontSize: 'clamp(20px, 4vw, 32px)', 
              fontWeight: 900, 
              margin: 0, 
              letterSpacing: '-1px', 
              background: 'var(--header-text-gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              textShadow: 'var(--header-text-shadow)',
              lineHeight: 1.1
            }}>
              ATLAS INTELLIGENCE COMMAND
            </h1>
            <div style={{ fontSize: 'clamp(10px, 2vw, 13px)', color: '#a78bfa', fontWeight: 700, letterSpacing: 'clamp(1px, 0.5vw, 3px)', textTransform: 'uppercase', fontFamily: 'var(--mono)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="live-dot" style={{ width: 8, height: 8, background: 'var(--success)', borderRadius: '50%', boxShadow: '0 0 12px var(--success)', animation: 'pulse-dot 2s infinite', flexShrink: 0 }} />
              System Online & Processing
            </div>
          </div>
        </div>

        {/* System Controls */}
        <div style={{ position: 'relative', zIndex: 2, display: 'flex', gap: 12, flexWrap: 'wrap', flex: '1 1 auto', justifyContent: 'flex-end', minWidth: 'min(100%, 300px)' }}>
          <select 
            className="btn" 
            style={{ 
              appearance: 'none', background: 'rgba(255,255,255,0.05)', color: 'white', 
              border: '1px solid var(--border)', textAlign: 'center', cursor: 'pointer',
              fontWeight: 600, padding: '8px 16px', borderRadius: 8, flex: '1 1 auto'
            }} 
            value={crawlPace} 
            onChange={changePace}
          >
            <option value="slow" style={{ color: 'black' }}>Pace: Slow</option>
            <option value="normal" style={{ color: 'black' }}>Pace: Normal</option>
            <option value="fast" style={{ color: 'black' }}>Pace: Fast</option>
          </select>
          
          <button 
            onClick={toggleMediaPause}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 16px',
              borderRadius: 8, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)',
              background: isMediaPaused ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.05)',
              color: isMediaPaused ? 'var(--primary)' : 'white',
              transition: 'all 0.2s', flex: '1 1 auto', whiteSpace: 'nowrap'
            }}
          >
            {isMediaPaused ? <RefreshCw size={14} /> : <Camera size={14} />}
            {isMediaPaused ? 'Media Paused' : 'Pause Media'}
          </button>
          
          <button 
            onClick={toggleGlobalPause}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 16px',
              borderRadius: 8, fontWeight: 600, cursor: 'pointer', border: 'none',
              background: isGlobalPaused ? 'var(--primary)' : 'var(--warning)',
              color: 'white', boxShadow: `0 0 12px ${isGlobalPaused ? 'rgba(59, 130, 246, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
              transition: 'all 0.2s', flex: '1 1 auto', whiteSpace: 'nowrap'
            }}
          >
            {isGlobalPaused ? <RefreshCw size={14} /> : <XCircle size={14} />}
            {isGlobalPaused ? 'System Resumed' : 'System Standby'}
          </button>
        </div>
      </div>

      {/* ── Crawl Queue Paused Warning ────── */}
      {isCrawlQueuePaused && (
        <div style={{
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 8, padding: '12px 20px', marginBottom: 'var(--spacing-lg)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <XCircle size={18} style={{ color: 'var(--error, #ef4444)', flexShrink: 0 }} />
            <span style={{ fontWeight: 700, color: 'var(--error, #ef4444)' }}>Crawl Queue Paused</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>— jobs are queued but workers will not pick them up until resumed.</span>
          </div>
          <button
            onClick={resumeCrawlQueue}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px',
              borderRadius: 8, fontWeight: 700, cursor: 'pointer', border: 'none',
              background: 'var(--success, #10b981)', color: 'white', whiteSpace: 'nowrap',
              boxShadow: '0 0 10px rgba(16,185,129,0.35)',
            }}
          >
            <RefreshCw size={14} /> Resume Queue
          </button>
        </div>
      )}

      {/* ── Health Recommendations (Phase 4) ────── */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        marginBottom: 'var(--spacing-lg)',
        overflow: 'hidden',
      }}>
        <HealthRecommendations />
      </div>

      {/* ── System Activity (Enrichment) ────── */}
      <div className="fluid-grid-large">
        <EnrichmentPanel />
      </div>

      {/* ── Intel Matrix ────── */}
      <div style={{
        marginBottom: 'var(--spacing-lg)',
        background: 'linear-gradient(160deg, rgba(139,92,246,0.04) 0%, rgba(59,130,246,0.03) 60%, rgba(16,185,129,0.03) 100%)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        overflow: 'hidden',
      }}>
        {/* Matrix header */}
        <div style={{ padding: '11px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.25)' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 3, color: 'var(--text-muted)', fontFamily: 'var(--mono)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={11} style={{ color: 'var(--accent)' }} /> INTEL MATRIX
          </span>
          <span style={{ fontSize: 10, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--mono)', fontWeight: 700, background: 'rgba(16,185,129,0.08)', padding: '3px 10px', borderRadius: 20, border: '1px solid rgba(16,185,129,0.2)' }}>
            <span style={{ width: 5, height: 5, background: 'var(--success)', borderRadius: '50%', animation: 'pulse-dot 2s infinite', display: 'inline-block', flexShrink: 0 }} /> LIVE
          </span>
        </div>

        {/* Primary metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderBottom: '1px solid var(--border)' }}>
          {[
            {
              label: 'VENUES',
              value: (stats?.total || 0).toLocaleString(),
              sub: `${(stats?.totalPhotos || 0).toLocaleString()} photos linked`,
              color: '#3b82f6',
              Icon: Building2,
            },
            {
              label: 'PHOTOS',
              value: (stats?.totalPhotos || 0).toLocaleString(),
              sub: 'media assets stored',
              color: '#f97316',
              Icon: Camera,
            },
            {
              label: 'TODAY',
              value: ((stats?.todayStats?.created || 0) + (stats?.todayStats?.updated || 0)).toLocaleString(),
              sub: `${stats?.todayStats?.created || 0} new · ${stats?.todayStats?.updated || 0} updated`,
              color: '#10b981',
              Icon: TrendingUp,
            },
          ].map((m, i) => (
            <div key={i} style={{
              padding: '28px 28px 24px',
              borderRight: i < 2 ? '1px solid var(--border)' : 'none',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${m.color}55, transparent)` }} />
              <div style={{ position: 'absolute', top: 16, right: 16, padding: 8, background: `${m.color}0f`, borderRadius: 10, border: `1px solid ${m.color}22` }}>
                <m.Icon size={14} color={m.color} />
              </div>
              <div style={{ fontSize: 'clamp(28px, 3.5vw, 44px)', fontWeight: 900, fontFamily: 'var(--mono)', color: 'var(--text-primary)', letterSpacing: -2, lineHeight: 1, marginBottom: 8, textShadow: `0 0 48px ${m.color}30` }}>
                {m.value}
              </div>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 3, color: m.color, fontFamily: 'var(--mono)', textTransform: 'uppercase', marginBottom: 4 }}>{m.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.sub}</div>
            </div>
          ))}
        </div>

        {/* Secondary metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {[
            {
              label: 'CRAWL ACTIVE',
              value: queueStats?.active ?? 0,
              sub: `${queueStats?.waiting || 0} waiting`,
              color: '#06b6d4',
            },
            {
              label: 'PHOTO DL',
              value: mediaQueueStats?.active ?? 0,
              sub: `${mediaQueueStats?.waiting || 0} queued`,
              color: '#8b5cf6',
            },
            {
              label: 'CHAINS',
              value: chainStats.count,
              sub: `${chainStats.totalLocs.toLocaleString()} locations`,
              color: '#f59e0b',
            },
            {
              label: 'CITIES',
              value: stats?.topCities?.length || 0,
              sub: 'geographic coverage',
              color: '#ec4899',
            },
          ].map((m, i) => (
            <div key={i} style={{
              padding: '16px 20px',
              borderRight: i < 3 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ fontSize: 'clamp(18px, 2vw, 26px)', fontWeight: 900, fontFamily: 'var(--mono)', color: m.color, letterSpacing: -1, lineHeight: 1, marginBottom: 5 }}>{m.value}</div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2, color: 'var(--text-muted)', fontFamily: 'var(--mono)', textTransform: 'uppercase', marginBottom: 3 }}>{m.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Charts ────── */}
      <div className="fluid-grid">
        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <div style={{ padding: 6, background: 'rgba(59, 130, 246, 0.1)', borderRadius: 8, border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                <Building2 size={16} color="#3b82f6" />
              </div>
              Top Geographies
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--mono)', background: 'var(--bg-surface)', padding: '4px 10px', borderRadius: 12 }}>
              {cityData.reduce((s, c) => s + c.count, 0).toLocaleString()} Total
            </span>
          </div>
          {cityData.length > 0 ? (() => {
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 6px', maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
                {cityData.map((c, i) => {
                  const parts = c.name.split(',').map(p => p.trim());
                  const city    = parts[0] || c.name;
                  const color   = CHART_COLORS[i % CHART_COLORS.length];
                  return (
                    <motion.div 
                      key={c.name} 
                      whileHover={{ scale: 1.05, filter: 'brightness(1.1)' }}
                      style={{ 
                        display: 'flex', alignItems: 'center', gap: 6, 
                        padding: '4px 10px', borderRadius: 16, 
                        background: `linear-gradient(135deg, ${color}15, transparent)`, 
                        border: `1px solid ${color}33`,
                        cursor: 'default',
                        boxShadow: `0 2px 8px ${color}11`
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {city}
                      </span>
                      <span style={{
                        fontSize: 11, fontWeight: 800, fontFamily: 'var(--mono)',
                        color: 'var(--text-primary)', background: 'var(--bg-surface)', 
                        padding: '2px 6px', borderRadius: 10,
                        border: '1px solid var(--border)'
                      }}>
                        {c.count.toLocaleString()}
                      </span>
                    </motion.div>
                  );
                })}
              </div>
            );
          })() : <div className="empty-state">No city data</div>}
        </div>

        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <div style={{ padding: 6, background: 'rgba(139, 92, 246, 0.1)', borderRadius: 8, border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                <Activity size={16} color="#8b5cf6" />
              </div>
              Category Distribution
            </span>
          </div>
          {catData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <defs>
                  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                  {CHART_COLORS.map((color, i) => (
                    <linearGradient id={`grad-${i}`} x1="0" y1="0" x2="1" y2="1" key={i}>
                      <stop offset="0%" stopColor={color} stopOpacity={1} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.6} />
                    </linearGradient>
                  ))}
                </defs>
                <Pie 
                  data={catData} 
                  dataKey="value" 
                  nameKey="name" 
                  cx="50%" 
                  cy="45%" 
                  innerRadius={70} 
                  outerRadius={105} 
                  paddingAngle={4} 
                  stroke="none"
                  activeIndex={activeIndex}
                  activeShape={renderActiveShape}
                  onMouseEnter={(_, index) => setActiveIndex(index)}
                  animationDuration={1000}
                  animationEasing="ease-out"
                >
                  {catData.map((_, i) => (
                    <Cell 
                      key={i} 
                      fill={`url(#grad-${i % CHART_COLORS.length})`} 
                      style={{ cursor: 'pointer', filter: activeIndex === i ? 'drop-shadow(0 0 8px var(--text-muted))' : 'none' }}
                    />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'transparent' }} />
                <Legend 
                  verticalAlign="bottom" 
                  height={40} 
                  iconType="circle"
                  formatter={(v, entry, index) => (
                    <span style={{ 
                      fontSize: 11, 
                      fontWeight: activeIndex === index ? 700 : 500,
                      color: activeIndex === index ? 'var(--text-primary)' : '#94a3b8',
                      transition: 'color 0.2s',
                      cursor: 'pointer'
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    >
                      {v}
                    </span>
                  )} 
                />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="empty-state">No category data</div>}
        </div>
      </div>

      {/* ── Reconnaissance Targets (Chains) ────── */}
      <ChainsPanel onSelectGym={setSelectedGym} />

      {/* ── Latest Gyms + Jobs ────── */}
      <div className="fluid-grid">
        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 12 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <div style={{ padding: 6, background: 'rgba(16, 185, 129, 0.1)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <Link2 size={16} color="#10b981" />
              </div>
              Latest Spaces
            </span>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
            {latestGyms.length > 0 ? latestGyms.map(g => (
              <GymRow key={g._id} gym={g} onClick={setSelectedGym} />
            )) : <div className="empty-state">No gyms yet</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 12 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <div style={{ padding: 6, background: 'rgba(245, 158, 11, 0.1)', borderRadius: 8, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                <Zap size={16} color="#f59e0b" />
              </div>
              Active & Recent Jobs
            </span>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
            {jobs.length > 0 ? jobs.map((j, i) => {
              const p = j.progress || {};
              const total = p.total || 0;
              const scraped = (p.scraped || 0) + (p.failed || 0) + (p.skipped || 0);
              const pct = total > 0 ? Math.min(100, Math.round((scraped / total) * 100)) : 0;
              const name = j.input?.cityName || j.input?.gymName || j.input?.chainName || 'Unknown';
              const typeIcon = j.type === 'chain' ? '🔗' : j.type === 'gym_name' ? '🏋' : '🏙️';
              const errorCount = j.errorCount || (j.jobErrors?.length) || 0;
              return (
                <motion.div 
                  key={j.jobId} 
                  whileHover={{ backgroundColor: 'var(--row-hover)' }}
                  style={{ 
                    padding: '12px 10px', 
                    borderBottom: i === jobs.length - 1 ? 'none' : '1px solid var(--border)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 12,
                    borderRadius: 8,
                    transition: 'background-color 0.2s'
                  }}
                >
                  <div style={{ 
                    width: 32, height: 32, borderRadius: 8, background: 'var(--bg-surface)', 
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 
                  }}>
                    {typeIcon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{name}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {errorCount > 0 && <span className="error-badge">{errorCount}</span>}
                        <span className={`badge-status ${j.status}`} style={{ fontSize: 10, padding: '2px 6px' }}>{j.status}</span>
                      </div>
                    </div>
                    {j.status === 'running' && (
                      <div className="progress-bar" style={{ marginTop: 8, marginBottom: 4, height: 4, background: 'var(--bg-surface)', border: 'none' }}>
                        <div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--warning)', boxShadow: '0 0 8px var(--warning)' }} />
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--mono)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--text-secondary)' }}>TOT</span> {total}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--success)' }}>NEW</span> {p.newSpaces || 0}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--danger)' }}>FAIL</span> {p.failed || 0}</span>
                      {p.batches > 0 && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ color: 'var(--accent)' }}>BAT</span> {p.batchesDone || 0}/{p.batches}</span>}
                    </div>
                  </div>
                </motion.div>
              );
            }) : <div className="empty-state"><div className="empty-state-icon">📭</div><div>No jobs</div></div>}
          </div>
        </div>
      </div>

      {/* ── System Actions ────── */}
      <SystemPanel />

      {/* ── Full Job History ────── */}
      <div style={{ marginTop: 24 }}>
        <JobsPanel />
      </div>





      {/* ── Gym Drawer ────── */}
      {selectedGym && <GymDrawer gymId={selectedGym} onClose={() => setSelectedGym(null)} />}
    </motion.div>
  );
}
