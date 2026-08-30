import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, Cell } from 'recharts';
import { ShieldCheck, AlertTriangle, Clock, Zap, Database, Activity, RefreshCw, Heart } from 'lucide-react';
import StatCard from '../components/StatCard';
import HealthRing from '../components/HealthRing';
import ChangeFeed from '../components/ChangeFeed';
import Skeleton from '../components/Skeleton';
import SpaceRow from '../components/SpaceRow';
import SpaceDrawer from '../components/SpaceDrawer';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const FIELD_META = {
  phone: { label: 'Phone', icon: '📞', color: '#3b82f6' },
  website: { label: 'Website', icon: '🌐', color: '#8b5cf6' },
  hours: { label: 'Hours', icon: '🕐', color: '#10b981' },
  photos: { label: 'Photos', icon: '📸', color: '#f59e0b' },
  description: { label: 'Description', icon: '📝', color: '#ec4899' },
  rating: { label: 'Rating', icon: '⭐', color: '#ef4444' },
  address: { label: 'Address', icon: '📍', color: '#06b6d4' },
  reviews: { label: 'Reviews', icon: '💬', color: '#f97316' },
  location: { label: 'Location', icon: '🗺️', color: '#6366f1' },
};

const QUALITY_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#10b981', '#3b82f6'];
const STALENESS_COLORS = { fresh: '#10b981', recent: '#3b82f6', aging: '#f59e0b', stale: '#ef4444' };

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 11 }}>
      <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || 'var(--text-muted)' }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
};

export default function DataHealth() {
  const { toast } = useApp();
  const [health, setHealth] = useState(null);
  const [worstSpaces, setWorstSpaces] = useState([]);
  const [changes, setChanges] = useState([]);
  const [dailyChanges, setDailyChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSpace, setSelectedSpace] = useState(null);
  const [enrichingIds, setEnrichingIds] = useState(new Set());

  const fetchAll = useCallback(async () => {
    try {
      const [healthRes, worstRes, changesRes, dailyRes] = await Promise.all([
        api.get('/api/data-health/overview').catch(() => null),
        api.get('/api/data-health/worst?limit=10').catch(() => null),
        api.get('/api/data-health/changes/significant?days=30&limit=15').catch(() => null),
        api.get('/api/data-health/changes/daily?days=14').catch(() => null),
      ]);
      if (healthRes?.success) setHealth(healthRes.health);
      if (worstRes?.success) setWorstSpaces(worstRes.spaces || []);
      if (changesRes?.success) setChanges(changesRes.changes || []);
      if (dailyRes?.success) setDailyChanges(dailyRes.dailyChanges || []);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const iv = setInterval(fetchAll, 60000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const handleEnrichSpace = async (spaceId, spaceName) => {
    setEnrichingIds(prev => new Set(prev).add(spaceId));
    try {
      const res = await api.post('/api/enrichment/priority', { spaceId, sections: ['all'] });
      if (res?.success) toast(`⚡ ${spaceName} queued for enrichment`, 'info');
      else toast(res?.error || 'Enrich failed', 'error');
    } catch (e) { toast(e.message, 'error'); }
    finally { setEnrichingIds(prev => { const n = new Set(prev); n.delete(spaceId); return n; }); }
  };

  const handleBatchEnrich = async () => {
    const ids = worstSpaces.slice(0, 10).map(g => g._id);
    try {
      const res = await api.post('/api/enrichment/priority/batch', { spaceIds: ids, sections: ['all'] });
      if (res?.success) toast(`⚡ ${res.pushed?.length || 0} spaces queued for enrichment`, 'info');
      else toast(res?.error || 'Batch enrich failed', 'error');
    } catch (e) { toast(e.message, 'error'); }
  };

  if (loading) return <div className="container"><Skeleton height={100} count={4} /></div>;
  if (!health) return <div className="container"><div className="empty-state">Failed to load health data</div></div>;

  const h = health;
  const mf = h.missingFields;
  const fieldEntries = Object.entries(mf).sort((a, b) => b[1].pct - a[1].pct);
  const stalenessData = [
    { name: '<7 days', value: h.staleness.fresh, fill: STALENESS_COLORS.fresh },
    { name: '7–30d', value: h.staleness.recent, fill: STALENESS_COLORS.recent },
    { name: '30–90d', value: h.staleness.aging, fill: STALENESS_COLORS.aging },
    { name: '>90d', value: h.staleness.stale, fill: STALENESS_COLORS.stale },
  ];
  const stalenessTotal = stalenessData.reduce((s, d) => s + d.value, 0) || 1;
  const freshPct = Math.round((h.staleness.fresh / stalenessTotal) * 100);
  const enrichPct = h.enrichmentStatus ? Math.round(((h.enrichmentStatus.success || 0) / h.totalSpaces) * 100) : 0;
  const reviewPct = Math.round((h.spacesWithReviews / h.totalSpaces) * 100);

  return (
    <motion.div className="container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {/* ── Command Center Header ────── */}
      <div style={{
        background: 'var(--header-glass-bg)',
        backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-glow)',
        borderRadius: 16,
        padding: '24px 30px',
        marginBottom: 20,
        boxShadow: 'var(--shadow)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.1, backgroundImage: 'linear-gradient(var(--text-muted) 1px, transparent 1px), linear-gradient(90deg, var(--text-muted) 1px, transparent 1px)', backgroundSize: '20px 20px', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--accent), transparent)' }} />
        
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ 
              padding: 16, 
              background: 'rgba(59, 130, 246, 0.1)', 
              borderRadius: 16, 
              border: '1px solid rgba(59, 130, 246, 0.3)',
              boxShadow: '0 0 24px rgba(59, 130, 246, 0.15)'
            }}>
              <ShieldCheck size={32} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 8px rgba(59, 130, 246, 0.4))' }} />
            </div>
            <div>
              <h1 style={{ 
                fontSize: 28, fontWeight: 900, margin: 0, letterSpacing: '-1px', 
                background: 'var(--header-text-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                textShadow: 'var(--header-text-shadow)' 
              }}>
                DATA HEALTH INTELLIGENCE
              </h1>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'var(--mono)', marginTop: 4 }}>
                {h.totalSpaces.toLocaleString()} Nodes · Status: <span style={{ color: 'var(--success)' }}>Optimal</span>
              </div>
            </div>
          </div>
          <button className="btn secondary sm" onClick={fetchAll} style={{ padding: '10px 16px', background: 'var(--bg-surface)' }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} style={{ marginRight: 8 }} /> Force Re-scan
          </button>
        </div>
      </div>

      {/* ── Health Overview Rings ────── */}
      <div className="card" style={{ marginBottom: 24, padding: '30px 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          <HealthRing value={h.avgCompleteness} label="Completeness" color="#3b82f6" icon={Database} />
          <HealthRing value={freshPct} label="Freshness" color="#10b981" icon={Clock} />
          <HealthRing value={enrichPct} label="Enriched" color="#8b5cf6" icon={Zap} />
          <HealthRing value={reviewPct} label="Has Reviews" color="#f59e0b" icon={Activity} />
        </div>
      </div>

      {/* Stat Cards */}
      {/* ── Stat Cards ────── */}
      <div className="grid" style={{ marginBottom: 24 }}>
        <StatCard title="Total Venues" value={h.totalSpaces} label="active in cluster" icon={<Database size={18} />} color="blue" />
        <StatCard title="Critical Stale" value={h.staleness.stale} label={`needs enrichment soon`} icon={<Clock size={18} />} color="orange" sublabel={`${h.staleness.aging} aging`} />
        <StatCard title="Closed/Risk" value={h.closedSpaces.permanently + h.closedSpaces.temporarily} label="flagged during crawl" icon={<AlertTriangle size={18} />} color="red" />
        <StatCard title="Significant Events" value={changes.length} label="recorded last 30d" icon={<Activity size={18} />} color="purple" />
      </div>

      {/* ── Detailed Metrics Grid ────── */}
      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card" style={{ padding: 24 }}>
          <div className="card-header" style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
            <span className="card-title" style={{ fontSize: 14 }}>Missing Data Gaps</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)', background: 'var(--bg-surface)', padding: '2px 8px', borderRadius: 4 }}>
               {fieldEntries.length} Tracked Fields
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {fieldEntries.map(([key, data]) => {
              const meta = FIELD_META[key] || { label: key, icon: '•', color: '#6b7280' };
              const pct = data.pct;
              return (
                <div key={key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
                      <span style={{ filter: 'grayscale(1)', opacity: 0.8 }}>{meta.icon}</span> {meta.label}
                    </span>
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: pct > 50 ? 'var(--danger)' : pct > 25 ? 'var(--warning)' : 'var(--success)', fontWeight: 800 }}>
                      {pct}% missing
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-surface)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${100 - pct}%` }}
                      transition={{ duration: 1, ease: 'easeOut' }}
                      style={{ height: '100%', background: `linear-gradient(90deg, ${meta.color}, ${meta.color}aa)`, boxShadow: `0 0 8px ${meta.color}44` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <div className="card-header" style={{ marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
            <span className="card-title" style={{ fontSize: 14 }}>Quality Distribution</span>
            <span className="card-icon"><Activity size={14} /></span>
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={h.qualityDistribution} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
              <defs>
                {QUALITY_COLORS.map((c, i) => (
                  <linearGradient id={`barGrad-${i}`} x1="0" y1="0" x2="0" y2="1" key={i}>
                    <stop offset="0%" stopColor={c} stopOpacity={0.8} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.2} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)', fontWeight: 600 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
              <Bar dataKey="count" name="Spaces" radius={[4, 4, 0, 0]}>
                {h.qualityDistribution.map((_, i) => (
                  <Cell key={i} fill={`url(#barGrad-${i})`} stroke={QUALITY_COLORS[i]} strokeWidth={1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 20, padding: 12, background: 'var(--bg-surface)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
             Average quality score: <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{h.avgCompleteness}%</span>. Scores are calculated based on field presence, photo count, and review recency.
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card" style={{ padding: 24 }}>
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title" style={{ fontSize: 14 }}>Staleness Index</span>
            <span className="card-icon">⏰</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {stalenessData.map((d, i) => {
              const pct = Math.round((d.value / stalenessTotal) * 100);
              return (
                <div key={d.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{d.name}</span>
                    <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: d.fill, fontWeight: 800 }}>
                      {pct}%
                    </span>
                  </div>
                  <div style={{ height: 10, background: 'var(--bg-surface)', borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 1, delay: i * 0.1 }}
                      style={{ height: '100%', background: d.fill, boxShadow: `0 0 10px ${d.fill}66` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 24, display: 'flex', height: 24, borderRadius: 12, overflow: 'hidden', border: '2px solid var(--border)', padding: 2 }}>
            {stalenessData.map(d => (
              <motion.div
                key={d.name}
                initial={{ width: 0 }}
                animate={{ width: `${(d.value / stalenessTotal) * 100}%` }}
                transition={{ duration: 1.2 }}
                style={{ background: d.fill, height: '100%', borderRight: '1px solid rgba(0,0,0,0.1)' }}
              />
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 24 }}>
          <div className="card-header" style={{ marginBottom: 16 }}>
            <span className="card-title" style={{ fontSize: 14 }}>System-Wide Changes</span>
            <span className="card-icon">📊</span>
          </div>
          {dailyChanges.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={dailyChanges} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="changeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="_id" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                  tickFormatter={v => v.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="total" name="Enrichments" stroke="var(--accent)" fill="url(#changeGrad)" strokeWidth={3} />
                <Area type="monotone" dataKey="spacesAffected" name="Venues" stroke="var(--success)" fill="none" strokeWidth={2} strokeDasharray="5 5" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <div className="empty-state">No telemetry data found</div>}
        </div>
      </div>

      {/* ── Reconnaissance + Enrichment Breakdown ────── */}
      <div className="grid-2" style={{ marginBottom: 24, alignItems: 'start' }}>
        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 16 }}>
            <span className="card-title" style={{ fontSize: 14 }}>Priority Reconnaissance Feed</span>
          </div>
          <div style={{ maxHeight: 440, overflowY: 'auto', paddingRight: 8 }} className="custom-scrollbar">
            <ChangeFeed changes={changes} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="card-header" style={{ marginBottom: 16 }}>
              <span className="card-title" style={{ fontSize: 14 }}>Lowest Health Nodes</span>
              <button className="btn accent sm" onClick={handleBatchEnrich} style={{ background: 'var(--warning)', color: '#000', fontWeight: 800 }}>
                <Zap size={14} /> BATCH ENRICH (10)
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {worstSpaces.length > 0 ? worstSpaces.map(g => (
                <motion.div 
                  key={g._id} 
                  whileHover={{ backgroundColor: 'var(--row-hover)' }}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, borderBottom: '1px solid var(--border)', transition: 'background 0.2s' }}
                >
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setSelectedSpace(g._id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{g.name}</span>
                      <span style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 800, color: g.qualityScore < 30 ? 'var(--danger)' : 'var(--warning)' }}>
                        {g.qualityScore}%
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 6 }}>
                      {g.areaName} {g.missing?.length > 0 && <span style={{ color: 'var(--text-muted)' }}>• Missing: {g.missing.map(m => FIELD_META[m]?.icon || '•').join('')}</span>}
                    </div>
                  </div>
                  <button className="btn secondary sm" onClick={() => handleEnrichSpace(g._id, g.name)} disabled={enrichingIds.has(g._id)}>
                    {enrichingIds.has(g._id) ? <RefreshCw size={12} className="spin" /> : <Zap size={12} />}
                  </button>
                </motion.div>
              )) : <div className="empty-state">No targets found</div>}
            </div>
          </div>

          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { key: 'success', label: 'Enriched', color: 'var(--success)', icon: '✅' },
                { key: 'failed', label: 'Failed', color: 'var(--danger)', icon: '❌' },
                { key: 'never', label: 'Sync Only', color: 'var(--text-muted)', icon: '⏳' },
              ].map(s => {
                const count = h.enrichmentStatus?.[s.key] || 0;
                const pct = Math.round((count / h.totalSpaces) * 100);
                return (
                  <div key={s.key} style={{ flex: 1, minWidth: 100, padding: 12, borderRadius: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6 }}>{s.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: s.color }}>{pct}%</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {selectedSpace && <SpaceDrawer spaceId={selectedSpace} onClose={() => setSelectedSpace(null)} />}
    </motion.div>
  );
}
