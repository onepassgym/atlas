import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Target,
  Zap,
  Activity,
  RefreshCw,
  Camera,
  XCircle,
  BookOpen,
  ListOrdered,
  Radio,
  Sliders,
  HeartPulse,
  LayoutGrid
} from 'lucide-react';
import StatCard from '../components/StatCard';
import CrawlActivity from '../components/CrawlActivity';
import EnrichmentPanel from '../components/EnrichmentPanel';
import JobsPanel from '../components/JobsPanel';
import SystemPanel from '../components/SystemPanel';
import SystemHealth from '../components/SystemHealth';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

export default function CommandCenter() {
  const { crawlActivity, toast } = useApp();
  const [queueStats, setQueueStats] = useState(null);
  const [mediaQueueStats, setMediaQueueStats] = useState(null);
  const [isGlobalPaused, setIsGlobalPaused] = useState(false);
  const [crawlPace, setCrawlPace] = useState('normal');
  const [isMediaPaused, setIsMediaPaused] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'jobs' | 'live' | 'commands' | 'health'

  const fetchSystemState = useCallback(async () => {
    try {
      const [queueRes, stateRes] = await Promise.all([
        api.get('/api/crawl/queue/stats').catch(() => null),
        api.get('/api/system/state').catch(() => ({ state: {} })),
      ]);

      if (queueRes?.success) {
        setQueueStats(queueRes.queue);
        setMediaQueueStats(queueRes.mediaQueue);
      }
      if (stateRes?.state?.globalPause !== undefined) {
        setIsGlobalPaused(stateRes.state.globalPause);
      }
      if (stateRes?.state?.crawlPace !== undefined) {
        setCrawlPace(stateRes.state.crawlPace);
      }
      if (stateRes?.state?.mediaQueuePaused !== undefined) {
        setIsMediaPaused(stateRes.state.mediaQueuePaused);
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchSystemState();
    const interval = setInterval(fetchSystemState, 8000);
    return () => clearInterval(interval);
  }, [fetchSystemState]);

  const toggleGlobalPause = async () => {
    try {
      const res = await api.post('/api/system/global-pause', { paused: !isGlobalPaused });
      setIsGlobalPaused(!isGlobalPaused);
      if (toast) {
        toast(
          res?.message || (isGlobalPaused ? 'System Resumed' : 'System Standby Activated'),
          isGlobalPaused ? 'success' : 'warning'
        );
      }
    } catch {
      if (toast) toast('Failed to update system state', 'error');
    }
  };

  const changePace = async (e) => {
    const pace = e.target.value;
    try {
      const res = await api.post('/api/system/pace', { pace });
      setCrawlPace(pace);
      if (toast) toast(res?.message || 'Pace updated', 'info');
    } catch {
      if (toast) toast('Failed to update pace', 'error');
    }
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
    } catch {
      if (toast) toast('Failed to update media state', 'error');
    }
  };

  const throttleColor = crawlActivity.throttle <= 1.0 ? 'green' : crawlActivity.throttle <= 2.0 ? 'yellow' : 'red';
  const throttleLabel = crawlActivity.throttle <= 0.85 ? 'Cruising' : crawlActivity.throttle <= 1.1 ? 'Normal' : crawlActivity.throttle <= 2.0 ? 'Caution' : 'Throttled';

  return (
    <motion.div className="container" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      {/* ── Command Center Master Header ────── */}
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
        {/* Decorative Grid Pattern */}
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
              background: 'rgba(139, 92, 246, 0.12)',
              borderRadius: 16,
              border: '1px solid rgba(139, 92, 246, 0.3)',
              boxShadow: '0 0 24px rgba(139, 92, 246, 0.2)',
              flexShrink: 0,
            }}
          >
            <Target size={30} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 8px rgba(167, 139, 250, 0.5))' }} />
          </div>
          <div>
            <h1
              style={{
                fontSize: 'clamp(20px, 3.5vw, 30px)',
                fontWeight: 900,
                margin: 0,
                letterSpacing: '-0.8px',
                background: 'var(--header-text-gradient)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                lineHeight: 1.15,
              }}
            >
              COMMAND CENTER & JOB HISTORY
            </h1>
            <div
              style={{
                fontSize: 'clamp(10px, 1.8vw, 12px)',
                color: '#a78bfa',
                fontWeight: 700,
                letterSpacing: '2px',
                textTransform: 'uppercase',
                fontFamily: 'var(--mono)',
                marginTop: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  background: isGlobalPaused ? 'var(--warning)' : 'var(--success)',
                  borderRadius: '50%',
                  boxShadow: `0 0 10px ${isGlobalPaused ? 'var(--warning)' : 'var(--success)'}`,
                  display: 'inline-block',
                }}
              />
              {isGlobalPaused ? 'System Standby Activated' : 'System Online & Processing'}
            </div>
          </div>
        </div>

        {/* Global Controls */}
        <div style={{ position: 'relative', zIndex: 2, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <a
            href="/docs"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              border: '1px solid var(--accent)',
              background: 'rgba(139, 92, 246, 0.1)',
              color: 'var(--accent)',
              textDecoration: 'none',
              transition: 'all 0.2s',
            }}
          >
            <BookOpen size={14} />
            API Docs
          </a>

          <select
            className="btn"
            style={{
              appearance: 'none',
              background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
              textAlign: 'center',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              padding: '8px 14px',
              borderRadius: 8,
            }}
            value={crawlPace}
            onChange={changePace}
          >
            <option value="slow" style={{ color: 'black' }}>Pace: Slow (3x)</option>
            <option value="normal" style={{ color: 'black' }}>Pace: Normal (1x)</option>
            <option value="fast" style={{ color: 'black' }}>Pace: Fast (0.5x)</option>
          </select>

          <button
            onClick={toggleMediaPause}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: isMediaPaused ? 'rgba(99, 102, 241, 0.2)' : 'rgba(255,255,255,0.06)',
              color: isMediaPaused ? 'var(--primary)' : 'var(--text-primary)',
              transition: 'all 0.2s',
            }}
          >
            {isMediaPaused ? <RefreshCw size={14} /> : <Camera size={14} />}
            {isMediaPaused ? 'Media Paused' : 'Pause Media'}
          </button>

          <button
            onClick={toggleGlobalPause}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              border: 'none',
              background: isGlobalPaused ? 'var(--primary)' : 'var(--warning)',
              color: 'white',
              boxShadow: `0 0 12px ${isGlobalPaused ? 'rgba(59, 130, 246, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
              transition: 'all 0.2s',
            }}
          >
            {isGlobalPaused ? <RefreshCw size={14} /> : <XCircle size={14} />}
            {isGlobalPaused ? 'Resume Crawling' : 'System Standby'}
          </button>
        </div>
      </div>

      {/* ── Operational Telemetry Cards ────── */}
      <div className="grid" style={{ marginBottom: 20 }}>
        <StatCard
          title="Crawl Queue"
          value={queueStats?.active ?? 0}
          label={`${queueStats?.waiting || 0} waiting in line`}
          sublabel={`${queueStats?.completed || 0} batches finished`}
          icon={<Zap size={18} />}
          color="cyan"
        />
        <StatCard
          title="Photo Queue"
          value={mediaQueueStats?.active ?? 0}
          label={`${mediaQueueStats?.waiting || 0} waiting`}
          sublabel={isMediaPaused ? 'Pipeline Paused' : 'Active'}
          icon={<Camera size={18} />}
          color="indigo"
        />
        <StatCard
          title="Crawl Throttle"
          value={`${crawlActivity.throttle.toFixed(1)}x`}
          label={throttleLabel}
          sublabel={crawlActivity.status}
          icon={<Activity size={18} />}
          color={throttleColor}
        />
        <StatCard
          title="Operating Mode"
          value={crawlPace.toUpperCase()}
          label={isGlobalPaused ? 'Standby (Paused)' : 'Autonomous Running'}
          sublabel="Adaptive Circuit Breaker: Active"
          icon={<Target size={18} />}
          color={isGlobalPaused ? 'red' : 'green'}
        />
      </div>

      {/* ── Sub-Navigation Pill Filters ────── */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 20,
          padding: '6px',
          background: 'var(--bg-surface)',
          borderRadius: 12,
          border: '1px solid var(--border)',
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {[
          { id: 'all', label: 'All Operations', icon: LayoutGrid },
          { id: 'jobs', label: 'Job History', icon: ListOrdered },
          { id: 'live', label: 'Live Telemetry', icon: Radio },
          { id: 'commands', label: 'Command Dispatch', icon: Sliders },
          { id: 'health', label: 'System Health', icon: HeartPulse },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              border: 'none',
              background: activeTab === id ? 'var(--accent)' : 'transparent',
              color: activeTab === id ? '#fff' : 'var(--text-secondary)',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Section: Live Crawler & Enrichment Telemetry ────── */}
      {(activeTab === 'all' || activeTab === 'live') && (
        <div style={{ marginBottom: 24 }}>
          <div className="fluid-grid-large">
            <CrawlActivity />
            <EnrichmentPanel />
          </div>
        </div>
      )}

      {/* ── Section: Command Dispatcher (System Actions & Schedule) ────── */}
      {(activeTab === 'all' || activeTab === 'commands') && (
        <div style={{ marginBottom: 24 }}>
          <SystemPanel />
        </div>
      )}

      {/* ── Section: Full Job History ────── */}
      {(activeTab === 'all' || activeTab === 'jobs') && (
        <div style={{ marginBottom: 24 }}>
          <JobsPanel />
        </div>
      )}

      {/* ── Section: System Infrastructure Health ────── */}
      {(activeTab === 'all' || activeTab === 'health') && (
        <div style={{ marginBottom: 24 }}>
          <SystemHealth />
        </div>
      )}
    </motion.div>
  );
}
