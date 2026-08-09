import { useState, useEffect } from 'react';
import { Radio, CheckCircle2, AlertCircle, Clock, RefreshCw, Power } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const SOURCE_META = {
  google_maps:      { name: 'Google Maps',      color: '#4285F4', description: 'Primary source — Playwright stealth scraper with fingerprint rotation' },
  justdial:         { name: 'JustDial',          color: '#F05A28', description: 'India directory — 50M+ listings across all cities' },
  osm:              { name: 'OpenStreetMap',      color: '#7EBC6F', description: 'Overpass API — global free coverage, no API key required' },
  yelp:             { name: 'Yelp',              color: '#D32323', description: 'Yelp Fusion API — requires API key, international coverage' },
  official_website: { name: 'Official Website',  color: '#8B5CF6', description: 'JSON-LD extraction, pricing & class schedule detection' },
};

function SourceCard({ source, onToggle }) {
  const meta = SOURCE_META[source.sourceId] || { name: source.sourceId, color: '#52525B', description: '' };
  const errorRate = source.success + source.error > 0
    ? Math.round((source.error / (source.success + source.error)) * 100)
    : 0;
  const isHealthy = errorRate < 20;

  return (
    <div style={{
      background: '#0A0A0A',
      border: `1px solid ${source.enabled ? '#1A1A1A' : '#111'}`,
      borderRadius: 12,
      padding: '18px 20px',
      opacity: source.enabled ? 1 : 0.5,
      transition: 'all 0.2s',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', marginTop: 1,
            background: source.enabled ? meta.color : '#3F3F46',
            boxShadow: source.enabled && isHealthy ? `0 0 8px ${meta.color}88` : 'none',
          }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#FAFAFA' }}>{meta.name}</div>
            <div style={{ fontSize: 11, color: '#52525B', marginTop: 2 }}>{meta.description}</div>
          </div>
        </div>
        <button
          onClick={() => onToggle(source.sourceId, !source.enabled)}
          title={source.enabled ? 'Disable source' : 'Enable source'}
          style={{
            width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: source.enabled ? 'rgba(124,58,237,0.12)' : '#111',
            border: `1px solid ${source.enabled ? 'rgba(124,58,237,0.3)' : '#222'}`,
            cursor: 'pointer', color: source.enabled ? '#A78BFA' : '#52525B',
          }}
        >
          <Power size={13} />
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Stat label="Success" value={source.success.toLocaleString()} color="#10B981" />
        <Stat label="Errors"  value={source.error.toLocaleString()}   color={source.error > 0 ? '#EF4444' : '#52525B'} />
        <Stat label="Error Rate" value={`${errorRate}%`} color={isHealthy ? '#10B981' : '#EF4444'} />
      </div>

      {/* Last used */}
      {source.lastUsedAt && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#52525B' }}>
          <Clock size={10} />
          Last used: {new Date(source.lastUsedAt).toLocaleString()}
        </div>
      )}

      {/* Health indicator */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
        {source.enabled ? (
          isHealthy
            ? <><CheckCircle2 size={11} style={{ color: '#10B981' }} /><span style={{ fontSize: 11, color: '#10B981' }}>Healthy</span></>
            : <><AlertCircle size={11} style={{ color: '#EF4444' }} /><span style={{ fontSize: 11, color: '#EF4444' }}>High error rate</span></>
        ) : (
          <span style={{ fontSize: 11, color: '#52525B' }}>Disabled</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: '#111', borderRadius: 8, padding: '8px 10px', border: '1px solid #1A1A1A' }}>
      <div style={{ fontSize: 10, color: '#52525B', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: 'var(--mono)' }}>{value}</div>
    </div>
  );
}

export default function SourcesPage() {
  const { toast } = useApp();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/system/sources/health');
      if (res?.success) setSources(res.sources || []);
    } catch {
      toast('Could not load source health', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleToggle = async (sourceId, enable) => {
    try {
      const res = await api.post('/api/system/sources/toggle', { sourceId, enable });
      if (res?.success) {
        setSources(prev => prev.map(s => s.sourceId === sourceId ? { ...s, enabled: enable } : s));
        toast(`${SOURCE_META[sourceId]?.name || sourceId} ${enable ? 'enabled' : 'disabled'}`, 'info');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const totalSuccess = sources.reduce((a, s) => a + (s.success || 0), 0);
  const totalErrors  = sources.reduce((a, s) => a + (s.error   || 0), 0);
  const activeSources = sources.filter(s => s.enabled).length;

  return (
    <div className="container">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Radio size={18} style={{ color: '#7C3AED' }} />
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, letterSpacing: '-0.3px' }}>Data Sources</h1>
          <span style={{ fontSize: 12, color: '#52525B', fontFamily: 'var(--mono)', background: '#111', border: '1px solid #222', padding: '2px 8px', borderRadius: 6 }}>
            {activeSources}/{sources.length} active
          </span>
        </div>
        <button className="btn sm" onClick={load} disabled={loading}>
          <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          Refresh
        </button>
      </div>

      {/* Summary stats */}
      {sources.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 24 }}>
          <SummaryCard label="Total Requests" value={(totalSuccess + totalErrors).toLocaleString()} color="#7C3AED" />
          <SummaryCard label="Total Success"  value={totalSuccess.toLocaleString()} color="#10B981" />
          <SummaryCard label="Total Errors"   value={totalErrors.toLocaleString()}  color={totalErrors > 0 ? '#EF4444' : '#52525B'} />
        </div>
      )}

      {/* Source cards */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} style={{ height: 180, background: '#0A0A0A', borderRadius: 12, border: '1px solid #1A1A1A' }} />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px', color: '#52525B', fontSize: 13 }}>
          No sources available — ensure the API server is running
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {sources.map(s => <SourceCard key={s.sourceId} source={s} onToggle={handleToggle} />)}
        </div>
      )}

      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ background: '#0A0A0A', border: '1px solid #1A1A1A', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: '#52525B', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: 'var(--mono)' }}>{value}</div>
    </div>
  );
}
