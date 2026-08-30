import { useApp } from '../context/AppContext';
import { motion, AnimatePresence, useSpring, useMotionValue, animate } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Activity, Zap, Package, Search, Clock, AlertTriangle } from 'lucide-react';

/* ─── Constants ─────────────────────────────────────────── */
const STATUS_CONFIG = {
  idle:      { label: 'Idle',      color: '#6b7280', glow: 'rgba(107,114,128,0.3)',  icon: Activity,    pulse: false },
  searching: { label: 'Searching', color: '#06b6d4', glow: 'rgba(6,182,212,0.35)',   icon: Search,      pulse: true  },
  scraping:  { label: 'Scraping',  color: '#10b981', glow: 'rgba(16,185,129,0.35)',  icon: Zap,         pulse: true  },
  paused:    { label: 'Paused',    color: '#f59e0b', glow: 'rgba(245,158,11,0.3)',   icon: Clock,       pulse: false },
  blocked:   { label: 'Blocked',   color: '#ef4444', glow: 'rgba(239,68,68,0.35)',   icon: AlertTriangle, pulse: true },
};

const ACTION_META = {
  'space-start':    { bg: 'rgba(59,130,246,0.08)',  border: 'rgba(59,130,246,0.25)',  dot: '#3b82f6',  icon: '⚡' },
  'space-done':     { bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.25)',  dot: '#10b981',  icon: '✅' },
  'space-failed':   { bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)',   dot: '#ef4444',  icon: '❌' },
  'batch-start':  { bg: 'rgba(139,92,246,0.08)',  border: 'rgba(139,92,246,0.25)',  dot: '#8b5cf6',  icon: '📦' },
  'batch-done':   { bg: 'rgba(16,185,129,0.08)',  border: 'rgba(16,185,129,0.25)',  dot: '#10b981',  icon: '🏁' },
  'search-start': { bg: 'rgba(6,182,212,0.08)',   border: 'rgba(6,182,212,0.25)',   dot: '#06b6d4',  icon: '🔎' },
  'search-done':  { bg: 'rgba(6,182,212,0.08)',   border: 'rgba(6,182,212,0.25)',   dot: '#06b6d4',  icon: '📋' },
  'throttle':     { bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)',  dot: '#f59e0b',  icon: '⚙️' },
  'block':        { bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)',   dot: '#ef4444',  icon: '🛑' },
  'pause':        { bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)',  dot: '#f59e0b',  icon: '☕' },
  default:        { bg: 'rgba(107,114,128,0.06)', border: 'rgba(107,114,128,0.15)', dot: '#6b7280',  icon: '•' },
};

/* ─── Helpers ────────────────────────────────────────────── */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatCategory(cat) {
  if (!cat) return '?';
  return String(cat).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getActionText(a) {
  switch (a.type) {
    case 'space-start':    return `Scraping: ${decodeURIComponent(a.url || '?').slice(0, 50)}`;
    case 'space-done':     return `Done: ${a.name} — ${((a.duration || 0)/1000).toFixed(1)}s`;
    case 'space-failed':   return `${a.isBlock ? '🛑 Blocked' : 'Failed'}: ${a.error?.slice(0, 55) || '?'} (attempt ${a.attempt})`;
    case 'batch-start':  return `Batch #${a.batch} — ${a.city} · ${a.urls} URLs`;
    case 'batch-done':   return `Batch #${a.batch} done · ✅${a.stats?.created||0} 🔄${a.stats?.updated||0} ❌${a.stats?.failed||0}`;
    case 'search-start': return `Discovery: "${formatCategory(a.category)}" in ${a.city}`;
    case 'search-done':  return `Found ${a.found} URLs (${a.total} unique)`;
    case 'throttle':     return `Throttle ${a.direction === 'faster' ? '↓' : '↑'} → ${a.multiplier?.toFixed(2)}×`;
    case 'block':        return `Google block — cooldown ${((a.cooldown||0)/1000).toFixed(0)}s`;
    case 'pause':        return `Human pause ${((a.duration||0)/1000).toFixed(1)}s`;
    default:             return JSON.stringify(a).slice(0, 60);
  }
}

/* ─── Animated Arc Gauge ─────────────────────────────────── */
function ArcGauge({ value, max = 4, color, label, sublabel }) {
  const r = 36, cx = 44, cy = 44;
  const strokeW = 8;
  const circumference = Math.PI * r; // half-circle arc
  const pct = Math.min(1, value / max);
  const dashOffset = circumference * (1 - pct);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={88} height={52} viewBox="0 0 88 52">
        {/* Track */}
        <path
          d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeW}
          strokeLinecap="round"
        />
        {/* Fill */}
        <motion.path
          d={`M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={circumference}
          animate={{ strokeDashoffset: dashOffset }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
        {/* Glow dot at tip */}
        <motion.circle
          animate={{
            cx: cx + r * Math.cos(Math.PI - pct * Math.PI),
            cy: cy - r * Math.sin(pct * Math.PI),
          }}
          r={strokeW / 2 + 1}
          fill={color}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 5px ${color})` }}
        />
        {/* Center text */}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="13" fontWeight="700" fill={color} fontFamily="var(--mono)">
          {value.toFixed(2)}×
        </text>
      </svg>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: -4 }}>{label}</div>
      {sublabel && <div style={{ fontSize: 10, color, fontWeight: 600 }}>{sublabel}</div>}
    </div>
  );
}

/* ─── Activity Ring (status indicator) ──────────────────── */
function ActivityRing({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;
  const StatusIcon = cfg.icon;

  return (
    <div style={{ position: 'relative', width: 52, height: 52, flexShrink: 0 }}>
      {/* Outer pulse ring */}
      {cfg.pulse && (
        <motion.div
          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: `2px solid ${cfg.color}`,
            boxShadow: `0 0 12px ${cfg.glow}`,
          }}
        />
      )}
      {/* Main ring */}
      <motion.div
        animate={cfg.pulse ? { boxShadow: [`0 0 8px ${cfg.glow}`, `0 0 20px ${cfg.glow}`, `0 0 8px ${cfg.glow}`] } : {}}
        transition={{ duration: 1.5, repeat: Infinity }}
        style={{
          width: 52, height: 52, borderRadius: '50%',
          background: `radial-gradient(circle at 35% 35%, ${cfg.glow}, transparent)`,
          border: `2px solid ${cfg.color}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <StatusIcon size={22} color={cfg.color} strokeWidth={2} />
      </motion.div>
    </div>
  );
}

/* ─── Mini Sparkline (throughput over recent actions) ─────── */
function Sparkline({ actions }) {
  const W = 120, H = 32, pad = 4;
  if (!actions.length) return null;

  // Count events per second bucket (last 15 actions)
  const recent = actions.slice(0, 15).reverse();
  const points = recent.map((a, i) => ({
    x: pad + (i / Math.max(recent.length - 1, 1)) * (W - pad * 2),
    y: H - pad - (a.type === 'space-done' ? H - pad * 2 : a.type === 'space-failed' ? (H - pad * 2) * 0.2 : (H - pad * 2) * 0.6),
    color: a.type === 'space-done' ? '#10b981' : a.type === 'space-failed' ? '#ef4444' : '#3b82f6',
  }));

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].x} ${H - pad} L ${points[0].x} ${H - pad} Z`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Activity Trace
      </div>
      <svg width={W} height={H} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <motion.path d={areaD} fill="url(#sparkGrad)"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} />
        {/* Line */}
        <motion.path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, ease: 'easeOut' }} />
        {/* Dots */}
        {points.map((p, i) => (
          <motion.circle key={i} cx={p.x} cy={p.y} r={i === points.length - 1 ? 3.5 : 2}
            fill={p.color}
            initial={{ scale: 0 }} animate={{ scale: 1 }}
            transition={{ delay: i * 0.02 }}
            style={i === points.length - 1 ? { filter: `drop-shadow(0 0 4px ${p.color})` } : {}}
          />
        ))}
      </svg>
    </div>
  );
}

/* ─── Progress Band ──────────────────────────────────────── */
function ProgressBand({ value, total, label, color }) {
  const pct = total > 0 ? Math.min(100, ((value + 1) / total) * 100) : 0;
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color, fontWeight: 700 }}>{value + 1} / {total}</span>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <motion.div
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          style={{
            height: '100%', borderRadius: 3,
            background: `linear-gradient(90deg, ${color}, ${color}88)`,
            boxShadow: `0 0 6px ${color}66`,
          }}
        />
      </div>
    </div>
  );
}

/* ─── Event Stream Row ───────────────────────────────────── */
function EventRow({ action, index }) {
  const meta = ACTION_META[action.type] || ACTION_META.default;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -16, height: 0 }}
      animate={{ opacity: 1, x: 0, height: 'auto' }}
      exit={{ opacity: 0, x: 16, height: 0 }}
      transition={{ duration: 0.25, delay: index === 0 ? 0 : 0 }}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '7px 10px', borderRadius: 8, marginBottom: 4,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        overflow: 'hidden',
      }}
    >
      {/* Timeline dot */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2, flexShrink: 0 }}>
        <motion.div
          animate={index === 0 ? { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] } : {}}
          transition={{ duration: 1.2, repeat: index === 0 ? 3 : 0 }}
          style={{ width: 8, height: 8, borderRadius: '50%', background: meta.dot, boxShadow: index === 0 ? `0 0 6px ${meta.dot}` : 'none' }}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, marginBottom: 1 }}>
          <span style={{ fontSize: 12, color: meta.dot, fontWeight: 600, lineHeight: 1.3, wordBreak: 'break-all' }}>
            {meta.icon} {getActionText(action)}
          </span>
        </div>
        {action.timestamp && (
          <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
            {fmtTime(action.timestamp)}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ─── Main Component ─────────────────────────────────────── */
export default function CrawlActivity() {
  const { crawlActivity } = useApp();
  const { currentSpace, batch, throttle, recentActions, status } = crawlActivity;
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;

  // Count stats from recent actions
  const doneCount  = recentActions.filter(a => a.type === 'space-done').length;
  const failCount  = recentActions.filter(a => a.type === 'space-failed').length;
  const blockCount = recentActions.filter(a => a.type === 'block').length;

  const throttleLabel =
    throttle <= 0.85 ? 'Cruising' :
    throttle <= 1.1  ? 'Normal'   :
    throttle <= 2.0  ? 'Caution'  : 'Emergency';

  const throttleColor =
    throttle <= 1.0 ? '#10b981' :
    throttle <= 2.0 ? '#f59e0b' : '#ef4444';

  return (
    <motion.div
      className="card crawl-activity-card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      style={{ 
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      {/* ── Header ── */}
      <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ padding: 6, background: `${cfg.color}15`, borderRadius: 8, border: `1px solid ${cfg.color}33` }}>
            <cfg.icon size={18} color={cfg.color} />
          </div>
          <div>
            <span className="card-title" style={{ color: 'var(--text-primary)', marginBottom: 2, display: 'block' }}>Live Activity</span>
            <div style={{ fontSize: 11, color: cfg.color, fontFamily: 'var(--mono)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>
              {cfg.label}
            </div>
          </div>
        </div>
      </div>

      {/* ── Status + Throttle + Sparkline row ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '0 4px 14px', borderBottom: '1px solid var(--border)' }}>

        {/* Activity Ring */}
        <ActivityRing status={status} />

        {/* Middle: Status text + batch info */}
        <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
            {status === 'idle' ? 'Waiting for crawler events…' :
             status === 'paused' ? '⏸ Enrichment paused' :
             status === 'blocked' ? '🛑 Google block detected' :
             batch ? `${batch.cityName} · Batch #${batch.batchIndex}` :
             'Crawler active'}
          </div>
          {batch && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span>📦 {batch.urlCount} URLs</span>
              <span>✅ {doneCount} done</span>
              {failCount > 0 && <span style={{ color: 'var(--danger)' }}>❌ {failCount} failed</span>}
              {blockCount > 0 && <span style={{ color: 'var(--danger)' }}>🛑 {blockCount} blocks</span>}
            </div>
          )}

          {/* Current URL progress */}
          <AnimatePresence>
            {status !== 'idle' && currentSpace && (
              <motion.div
                key={currentSpace.url}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{ marginTop: 8 }}
              >
                <ProgressBand
                  value={currentSpace.urlIndex}
                  total={currentSpace.total}
                  label={status === 'searching' ? 'Discovery' : 'Batch'}
                  color={cfg.color}
                />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                  {status === 'searching'
                    ? `Searching: "${formatCategory(currentSpace.url)}"`
                    : decodeURIComponent(currentSpace.url || '').slice(0, 60)}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right side: Arc gauge + sparkline */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <ArcGauge value={throttle} max={4} color={throttleColor} label="Throttle" sublabel={throttleLabel} />
          <Sparkline actions={recentActions} />
        </div>
      </div>

      {/* ── Event Stream ── */}
      <div style={{ paddingTop: 12 }}>
        <div style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>Event Stream</span>
          {recentActions.length > 0 && (
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
              {recentActions.length} events
            </span>
          )}
        </div>

        <div style={{ maxHeight: 240, overflowY: 'auto', scrollbarWidth: 'thin', paddingRight: 2 }}>
          <AnimatePresence initial={false}>
            {recentActions.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 12 }}
              >
                <div style={{ fontSize: 28, marginBottom: 6 }}>📡</div>
                <div>Waiting for crawler events…</div>
                <div style={{ fontSize: 11, marginTop: 4, opacity: 0.6 }}>Events appear in real-time via SSE</div>
              </motion.div>
            ) : (
              recentActions.map((action, i) => (
                <EventRow key={`${action.timestamp}-${i}`} action={action} index={i} />
              ))
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
