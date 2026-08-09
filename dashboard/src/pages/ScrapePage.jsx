import { useState, useEffect, useRef } from 'react';
import { Target, Link2, MapPin, Search, Loader2, CheckCircle2, AlertCircle, ExternalLink, ChevronDown } from 'lucide-react';
import { crawlsApi } from '../api/endpoints';
import { useApp } from '../context/AppContext';

const TABS = [
  { id: 'name',  label: 'By Name',  icon: Search  },
  { id: 'url',   label: 'By URL',   icon: Link2   },
  { id: 'area',  label: 'By Area',  icon: MapPin  },
];

const SOURCE_LABELS = {
  google_maps:      'Google Maps',
  justdial:         'JustDial',
  osm:              'OpenStreetMap',
  yelp:             'Yelp',
  official_website: 'Official Website',
};

function SourceBadge({ sourceId }) {
  const colors = {
    google_maps:      '#4285F4',
    justdial:         '#F05A28',
    osm:              '#7EBC6F',
    yelp:             '#D32323',
    official_website: '#8B5CF6',
  };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
      background: (colors[sourceId] || '#6B7280') + '22',
      color: colors[sourceId] || '#6B7280',
      border: `1px solid ${colors[sourceId] || '#6B7280'}44`,
    }}>
      {SOURCE_LABELS[sourceId] || sourceId}
    </span>
  );
}

function JobStatusBadge({ status }) {
  const map = {
    queued:    { color: '#F59E0B', label: 'Queued'    },
    running:   { color: '#3B82F6', label: 'Running'   },
    completed: { color: '#10B981', label: 'Completed' },
    failed:    { color: '#EF4444', label: 'Failed'    },
    cancelled: { color: '#6B7280', label: 'Cancelled' },
  };
  const { color, label } = map[status] || { color: '#6B7280', label: status };
  return (
    <span style={{ color, fontSize: 12, fontWeight: 700 }}>● {label}</span>
  );
}

function ScrapeByName() {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [deepCrossRef, setDeepCrossRef] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { showToast } = useApp();

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true); setResult(null); setError(null);
    try {
      const res = await crawlsApi.scrapeByName({ name: name.trim(), location: location.trim() || null, deepCrossRef });
      setResult(res.data);
      showToast?.(`Job queued: ${res.data?.jobId}`, 'success');
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle}>Fitness Space Name <span style={{ color: '#EF4444' }}>*</span></label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Cult.Fit Sector 49 Gurgaon"
          style={inputStyle}
          required
        />
        <p style={helpStyle}>Search across Google Maps, JustDial, Yelp, and OpenStreetMap simultaneously.</p>
      </div>
      <div>
        <label style={labelStyle}>City / Location (optional)</label>
        <input
          value={location}
          onChange={e => setLocation(e.target.value)}
          placeholder="e.g. Gurgaon, Haryana"
          style={inputStyle}
        />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={deepCrossRef} onChange={e => setDeepCrossRef(e.target.checked)} />
        <span>Deep cross-reference (scrape official website + all other sources)</span>
      </label>
      <button type="submit" disabled={submitting || !name.trim()} style={btnStyle(submitting || !name.trim())}>
        {submitting ? <><Loader2 size={14} className="spin" /> Searching all sources…</> : <><Search size={14} /> Search & Scrape</>}
      </button>
      {result && <JobResult result={result} />}
      {error  && <ErrorBox message={error} />}
    </form>
  );
}

function ScrapeByUrl() {
  const [url, setUrl] = useState('');
  const [deepCrossRef, setDeepCrossRef] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { showToast } = useApp();

  const detectedSource = () => {
    if (!url) return null;
    if (/google\.(com|co\.).*\/maps\//i.test(url)) return 'google_maps';
    if (/justdial\.com/i.test(url)) return 'justdial';
    if (/yelp\.com\/biz/i.test(url)) return 'yelp';
    if (/openstreetmap\.org/i.test(url)) return 'osm';
    if (/facebook\.com/i.test(url)) return null;
    if (url.startsWith('http')) return 'official_website';
    return null;
  };

  const source = detectedSource();

  const submit = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true); setResult(null); setError(null);
    try {
      const res = await crawlsApi.scrapeByUrl({ url: url.trim(), deepCrossRef });
      setResult(res.data);
      showToast?.(`Job queued: ${res.data?.jobId}`, 'success');
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle}>Fitness Space URL <span style={{ color: '#EF4444' }}>*</span></label>
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://maps.google.com/maps/place/... or any source URL"
          style={inputStyle}
          type="url"
          required
        />
        {source && (
          <p style={{ ...helpStyle, display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            Detected source: <SourceBadge sourceId={source} />
          </p>
        )}
        <p style={helpStyle}>
          Supports: Google Maps, JustDial, Yelp, OpenStreetMap, or any official gym website.
          The system auto-detects the source and scrapes accordingly.
        </p>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={deepCrossRef} onChange={e => setDeepCrossRef(e.target.checked)} />
        <span>Deep cross-reference (search this gym across all other sources after scraping)</span>
      </label>
      <button type="submit" disabled={submitting || !url.trim()} style={btnStyle(submitting || !url.trim())}>
        {submitting ? <><Loader2 size={14} className="spin" /> Scraping…</> : <><Link2 size={14} /> Scrape URL</>}
      </button>
      {result && <JobResult result={result} />}
      {error  && <ErrorBox message={error} />}
    </form>
  );
}

function ScrapeByArea() {
  const [area, setArea] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { showToast } = useApp();

  const submit = async (e) => {
    e.preventDefault();
    if (!area.trim()) return;
    setSubmitting(true); setResult(null); setError(null);
    try {
      const res = await crawlsApi.scrapeByArea({ area: area.trim() });
      setResult(res.data);
      showToast?.(`Area crawl queued for ${area}`, 'success');
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle}>City / Area <span style={{ color: '#EF4444' }}>*</span></label>
        <input
          value={area}
          onChange={e => setArea(e.target.value)}
          placeholder="e.g. Sector 29, Gurgaon or Mumbai, Maharashtra"
          style={inputStyle}
          required
        />
        <p style={helpStyle}>
          Crawls Google Maps, JustDial, and OpenStreetMap for ALL fitness categories in this area.
          40+ categories including gym, yoga, crossfit, martial arts, swimming, dance, sports courts, and more.
        </p>
      </div>
      <button type="submit" disabled={submitting || !area.trim()} style={btnStyle(submitting || !area.trim())}>
        {submitting ? <><Loader2 size={14} className="spin" /> Queuing…</> : <><MapPin size={14} /> Start Area Crawl</>}
      </button>
      {result && <JobResult result={result} />}
      {error  && <ErrorBox message={error} />}
    </form>
  );
}

function JobResult({ result }) {
  const [tracking, setTracking] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!result?.jobId) return;
    // Poll job status every 3s until done
    const poll = async () => {
      try {
        const res = await crawlsApi.status(result.jobId);
        const job = res.data?.job;
        if (job) setTracking(job);
        if (['completed', 'failed', 'cancelled'].includes(job?.status)) {
          clearInterval(pollRef.current);
        }
      } catch (_) {}
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => clearInterval(pollRef.current);
  }, [result?.jobId]);

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Job Queued</span>
        {tracking && <JobStatusBadge status={tracking.status} />}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{result.jobId}</div>
      {tracking && (
        <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {tracking.progress?.newSpaces > 0 && (
            <span style={{ color: '#10B981' }}>✓ {tracking.progress.newSpaces} new spaces found</span>
          )}
          {tracking.progress?.updatedSpaces > 0 && (
            <span style={{ color: '#3B82F6' }}>↑ {tracking.progress.updatedSpaces} spaces updated</span>
          )}
          {tracking.status === 'running' && (
            <span style={{ color: '#F59E0B', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Loader2 size={11} className="spin" /> Running…
            </span>
          )}
          {tracking.status === 'completed' && (
            <span style={{ color: '#10B981', display: 'flex', alignItems: 'center', gap: 4 }}>
              <CheckCircle2 size={11} /> Complete
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorBox({ message }) {
  return (
    <div style={{ background: '#EF444411', border: '1px solid #EF4444', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#EF4444', display: 'flex', alignItems: 'center', gap: 8 }}>
      <AlertCircle size={14} /> {message}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 };
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--border)', background: 'var(--bg-input, var(--bg-card))',
  color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
};
const helpStyle = { fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' };
const btnStyle = (disabled) => ({
  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
  background: disabled ? 'var(--bg-hover, #374151)' : 'var(--accent, #3B82F6)',
  color: disabled ? 'var(--text-muted)' : '#fff',
  border: 'none', transition: 'all 0.2s', opacity: disabled ? 0.6 : 1,
  alignSelf: 'flex-start',
});

export default function ScrapePage() {
  const [activeTab, setActiveTab] = useState('name');
  const active = TABS.find(t => t.id === activeTab);

  return (
    <div className="container" style={{ maxWidth: 760, paddingTop: 28 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <Target size={22} style={{ color: 'var(--accent)' }} />
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: 'var(--text)' }}>ATLAS Scraper</h1>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
          Scrape fitness spaces from Google Maps, JustDial, Yelp, OpenStreetMap, and official websites simultaneously.
        </p>
      </div>

      {/* Source badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
        {Object.keys(SOURCE_LABELS).map(s => <SourceBadge key={s} sourceId={s} />)}
      </div>

      {/* Tab selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: 'var(--bg-card)', borderRadius: 10, padding: 4, border: '1px solid var(--border)' }}>
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: '8px 0', borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', border: 'none', transition: 'all 0.15s',
                background: isActive ? 'var(--accent, #3B82F6)' : 'transparent',
                color: isActive ? '#fff' : 'var(--text-muted)',
              }}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active tab content */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24 }}>
        {activeTab === 'name' && <ScrapeByName />}
        {activeTab === 'url'  && <ScrapeByUrl  />}
        {activeTab === 'area' && <ScrapeByArea />}
      </div>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
