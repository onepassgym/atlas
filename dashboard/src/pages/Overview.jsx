import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, Sector } from 'recharts';
import {
  Building2,
  Camera,
  Target,
  Link2,
  Activity,
  TrendingUp,
  Search,
  Sparkles,
  MapPin,
  ChevronRight,
} from 'lucide-react';
import StatCard from '../components/StatCard';
import Skeleton from '../components/Skeleton';
import SpaceRow from '../components/SpaceRow';
import SpacePreviewModal from '../components/SpacePreviewModal';
import ChainsPanel from '../components/ChainsPanel';

import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#f97316', '#ec4899'];

function formatCategory(cat) {
  if (!cat || cat === 'undefined' || cat === 'unknown') return 'Unknown';
  return String(cat)
    .replace(/_/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const CustomTooltip = ({ active, payload, totalVenues }) => {
  if (!active || !payload?.length) return null;
  const val = payload[0].value || 0;
  const pct = totalVenues > 0 ? ((val / totalVenues) * 100).toFixed(1) : '0.0';
  return (
    <div
      style={{
        background: 'var(--tooltip-glass-bg)',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--card-glass-border)',
        borderRadius: 12,
        padding: '12px 16px',
        fontSize: 13,
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        style={{
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: payload[0].payload.fill || CHART_COLORS[0],
            boxShadow: `0 0 8px ${payload[0].payload.fill || CHART_COLORS[0]}`,
          }}
        />
        {payload[0].payload.name || payload[0].payload._id}
      </div>
      <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--mono)' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 15 }}>
          {val.toLocaleString()}
        </span>{' '}
        venues <span style={{ color: 'var(--accent)', fontWeight: 700 }}>({pct}%)</span>
      </div>
    </div>
  );
};

const renderActiveSector = (props) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <g>
      <Sector
        cx={cx}
        cy={cy}
        innerRadius={innerRadius - 2}
        outerRadius={outerRadius + 6}
        startAngle={startAngle}
        endAngle={endAngle}
        fill={fill}
        style={{ filter: 'drop-shadow(0 0 8px rgba(0,0,0,0.4))' }}
      />
    </g>
  );
};

export default function Overview() {
  const { events, setChainsCache } = useApp();
  const [stats, setStats] = useState(null);
  const [latestSpaces, setLatestSpaces] = useState([]);
  const [selectedSpace, setSelectedSpace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [spaceRes, chainRes, latestRes] = await Promise.all([
        api.get('/api/spaces/stats').catch(() => null),
        api.get('/api/chains').catch(() => ({ chains: [] })),
        api.get('/api/spaces?limit=6&sortBy=createdAt').catch(() => null),
      ]);

      if (spaceRes?.success) setStats(spaceRes.stats);
      if (chainRes?.chains) {
        setChainsCache(chainRes.chains);
      }
      if (latestRes?.success) setLatestSpaces(latestRes.spaces || []);
    } catch {} finally {
      setLoading(false);
    }
  }, [setChainsCache]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Debounced refresh when spaces are created or updated
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    const type = latest?.type || '';

    if (type === 'space:created' || type === 'space:updated') {
      const timer = setTimeout(() => {
        api.get('/api/spaces/stats').then(r => r?.success && setStats(r.stats)).catch(() => {});
        api.get('/api/spaces?limit=6&sortBy=createdAt').then(r => r?.success && setLatestSpaces(r.spaces || [])).catch(() => {});
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [events]);

  if (loading) return <div className="container"><Skeleton height={100} count={3} /></div>;

  const cityData = (stats?.topCities || []).map(c => ({ name: c._id || 'Unknown', count: c.count }));
  const rawCatData = (stats?.byCategory || []).map(c => ({
    name: formatCategory(c.label || c._id),
    value: c.count,
  }));
  const totalCatVenues = rawCatData.reduce((s, c) => s + c.value, 0);
  const topCategories = rawCatData.slice(0, 7);
  const otherCount = rawCatData.slice(7).reduce((s, c) => s + c.value, 0);
  const catData = otherCount > 0 ? [...topCategories, { name: 'Other', value: otherCount }] : topCategories;

  return (
    <motion.div className="container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {/* ── Overview Intelligence Hero Header ────── */}
      <div
        style={{
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
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.08,
            backgroundImage:
              'linear-gradient(var(--text-muted) 1px, transparent 1px), linear-gradient(90deg, var(--text-muted) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
          }}
        />

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              padding: 16,
              background: 'rgba(59, 130, 246, 0.12)',
              borderRadius: 16,
              border: '1px solid rgba(59, 130, 246, 0.25)',
              boxShadow: '0 0 24px rgba(59, 130, 246, 0.18)',
              flexShrink: 0,
            }}
          >
            <Building2 size={30} style={{ color: 'var(--primary)', filter: 'drop-shadow(0 0 8px rgba(59, 130, 246, 0.4))' }} />
          </div>
          <div>
            <h1
              style={{
                fontSize: 'clamp(22px, 3.8vw, 32px)',
                fontWeight: 900,
                margin: 0,
                letterSpacing: '-0.8px',
                background: 'var(--header-text-gradient)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                lineHeight: 1.15,
              }}
            >
              VENUE INTELLIGENCE OVERVIEW
            </h1>
            <div
              style={{
                fontSize: 'clamp(10px, 1.8vw, 13px)',
                color: 'var(--text-secondary)',
                fontWeight: 600,
                marginTop: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>Verified Global Repository</span>
              <span>•</span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                {stats?.total?.toLocaleString() || 0} Venues Indexed
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons to navigate to Command Center and Explorer */}
        <div style={{ position: 'relative', zIndex: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link
            to="/command-center"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              borderRadius: 10,
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              border: '1px solid var(--accent)',
              background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(59, 130, 246, 0.15))',
              color: 'var(--accent)',
              textDecoration: 'none',
              boxShadow: '0 0 16px rgba(139, 92, 246, 0.2)',
              transition: 'all 0.2s',
            }}
          >
            <Target size={16} />
            Command Center & Job History
            <ChevronRight size={14} />
          </Link>

          <Link
            to="/explorer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              borderRadius: 10,
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'var(--text-primary)',
              textDecoration: 'none',
              transition: 'all 0.2s',
            }}
          >
            <Search size={15} />
            Space Explorer
          </Link>
        </div>
      </div>

      {/* ── High-Level Metric Cards ────── */}
      <div className="grid">
        <StatCard
          title="Total Venues"
          value={stats?.total}
          label="venues in repository"
          icon={<Building2 size={18} />}
          color="blue"
        />
        <StatCard
          title="Total Photos"
          value={stats?.totalPhotos}
          label="rich venue images"
          icon={<Camera size={18} />}
          color="orange"
        />
        <StatCard
          title="Top Cities"
          value={cityData.length}
          label="active geographic markets"
          icon={<MapPin size={18} />}
          color="cyan"
        />
        <StatCard
          title="Categories"
          value={(stats?.byCategory || []).length}
          label="fitness & wellness genres"
          icon={<Sparkles size={18} />}
          color="indigo"
        />
        <StatCard
          title="Today's Additions"
          value={stats?.todayStats?.created || 0}
          label="new spaces discovered"
          icon={<TrendingUp size={18} />}
          color="green"
        />
        <StatCard
          title="Today's Updates"
          value={stats?.todayStats?.updated || 0}
          label="spaces refreshed"
          icon={<Activity size={18} />}
          color="purple"
        />
      </div>

      {/* ── Intelligence Charts (Geographies & Categories) ────── */}
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
          {cityData.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 6px', maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
              {cityData.map((c, i) => {
                const parts = c.name.split(',').map(p => p.trim());
                const city  = parts[0] || c.name;
                const color = CHART_COLORS[i % CHART_COLORS.length];
                return (
                  <motion.div
                    key={c.name}
                    whileHover={{ scale: 1.05, filter: 'brightness(1.1)' }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 16,
                      background: `linear-gradient(135deg, ${color}15, transparent)`,
                      border: `1px solid ${color}33`,
                      cursor: 'default',
                      boxShadow: `0 2px 8px ${color}11`,
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {city}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        fontFamily: 'var(--mono)',
                        color: 'var(--text-primary)',
                        background: 'var(--bg-surface)',
                        padding: '2px 6px',
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                      }}
                    >
                      {c.count.toLocaleString()}
                    </span>
                  </motion.div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">No city data</div>
          )}
        </div>

        <div className="card">
          <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
            <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <div style={{ padding: 6, background: 'rgba(139, 92, 246, 0.1)', borderRadius: 8, border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                <Activity size={16} color="#8b5cf6" />
              </div>
              Category Distribution
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--mono)', background: 'var(--bg-surface)', padding: '4px 10px', borderRadius: 12 }}>
              {totalCatVenues.toLocaleString()} Total
            </span>
          </div>
          {catData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart onMouseLeave={() => setActiveIndex(null)}>
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
                  activeIndex={activeIndex !== null ? activeIndex : undefined}
                  activeShape={renderActiveSector}
                  onMouseEnter={(_, index) => setActiveIndex(index)}
                  animationDuration={800}
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
                {/* Center Donut Aggregate & Hover Stats */}
                <text
                  x="50%"
                  y="41%"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="var(--text-primary)"
                  style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--mono)' }}
                >
                  {activeIndex !== null && catData[activeIndex]
                    ? catData[activeIndex].value.toLocaleString()
                    : totalCatVenues.toLocaleString()}
                </text>
                <text
                  x="50%"
                  y="48%"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="var(--text-secondary)"
                  style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em' }}
                >
                  {activeIndex !== null && catData[activeIndex]
                    ? (catData[activeIndex].name.length > 18 ? catData[activeIndex].name.slice(0, 16) + '…' : catData[activeIndex].name)
                    : 'TOTAL VENUES'}
                </text>
                {activeIndex !== null && catData[activeIndex] && totalCatVenues > 0 && (
                  <text
                    x="50%"
                    y="55%"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--accent)"
                    style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'var(--mono)' }}
                  >
                    {((catData[activeIndex].value / totalCatVenues) * 100).toFixed(1)}%
                  </text>
                )}
                <Tooltip content={<CustomTooltip totalVenues={totalCatVenues} />} cursor={{ fill: 'transparent' }} />
                <Legend
                  verticalAlign="bottom"
                  height={40}
                  iconType="circle"
                  formatter={(v, entry, index) => (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: activeIndex === index ? 700 : 500,
                        color: activeIndex === index ? 'var(--text-primary)' : '#94a3b8',
                        transition: 'color 0.2s',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      {v}
                    </span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No category data</div>
          )}
        </div>
      </div>

      {/* ── Brand Chains Panel ────── */}
      <ChainsPanel onSelectSpace={setSelectedSpace} />

      {/* ── Latest Spaces Feed ────── */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 12 }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <div style={{ padding: 6, background: 'rgba(16, 185, 129, 0.1)', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
              <Link2 size={16} color="#10b981" />
            </div>
            Latest Indexed Venues
          </span>
          <Link
            to="/explorer"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            Explore All <ChevronRight size={14} />
          </Link>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}>
          {latestSpaces.length > 0 ? (
            latestSpaces.map(g => (
              <SpaceRow key={g.opgId} space={g} onClick={setSelectedSpace} />
            ))
          ) : (
            <div className="empty-state">No spaces yet</div>
          )}
        </div>
      </div>

      {/* ── Space Preview Popup ────── */}
      {selectedSpace && <SpacePreviewModal spaceId={selectedSpace} onClose={() => setSelectedSpace(null)} />}
    </motion.div>
  );
}
