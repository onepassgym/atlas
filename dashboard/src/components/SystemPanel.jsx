import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  Building2, Dumbbell, Calendar, Globe2, Brain, BarChart3, RefreshCw,
  FlaskConical, Trash2, XCircle, Plus, Rocket, ImagePlay
} from 'lucide-react';
import Modal from '../components/Modal';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

export default function SystemPanel() {
  const { toast, logs, clearLogs, chainsCache } = useApp();
  const [schedule, setSchedule] = useState([]);
  const [addCity, setAddCity] = useState({ name: '', frequency: 'weekly' });
  const [photoSync, setPhotoSync] = useState(null); // photo sync status

  // Modals
  const [crawlCityModal, setCrawlCityModal] = useState(false);
  const [crawlCityInput, setCrawlCityInput] = useState('');
  const [crawlSpaceModal, setCrawlSpaceModal] = useState(false);
  const [crawlSpaceInput, setCrawlSpaceInput] = useState('');
  const [chainCrawlModal, setChainCrawlModal] = useState(false);
  const [chainCrawlSlug, setChainCrawlSlug] = useState('');
  const [chainCrawlCountries, setChainCrawlCountries] = useState('');

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await api.get('/api/system/schedule');
      if (res?.success) setSchedule(res.schedule?.cities || []);
    } catch {}
  }, []);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  // ── Actions
  const submitCrawlCity = async () => {
    if (!crawlCityInput.trim()) return;
    setCrawlCityModal(false);

    let isJson = false;
    let parsedData = null;
    try {
      parsedData = JSON.parse(crawlCityInput);
      isJson = true;
    } catch(e) {}

    try {
      if (isJson) {
        let citiesArray = [];
        if (Array.isArray(parsedData)) {
          citiesArray = parsedData;
        } else if (parsedData && Array.isArray(parsedData.cities)) {
          citiesArray = parsedData.cities;
        } else if (parsedData && parsedData.cityName) {
          const res = await api.post('/api/crawl/city', { cityName: parsedData.cityName });
          toast(res?.success ? `Queued: ${parsedData.cityName}` : (res?.error || 'Failed'), res?.success ? 'success' : 'error');
          setCrawlCityInput('');
          return;
        } else {
          toast('Invalid JSON format. Expected array or { cities: [] }', 'error');
          return;
        }

        if (citiesArray.length > 0) {
          const res = await api.post('/api/crawl/batch', { cities: citiesArray });
          toast(res?.success ? (res?.message || `Queued ${citiesArray.length} cities`) : (res?.error || 'Failed'), res?.success ? 'success' : 'error');
        } else {
          toast('No cities found in JSON', 'error');
        }
      } else {
        const res = await api.post('/api/crawl/city', { cityName: crawlCityInput });
        toast(res?.success ? `Queued: ${crawlCityInput}` : (res?.error || 'Failed'), res?.success ? 'success' : 'error');
      }
      setCrawlCityInput('');
    } catch { toast('Network error', 'error'); }
  };

  const submitCrawlSpace = async () => {
    if (!crawlSpaceInput.trim()) return;
    setCrawlSpaceModal(false);
    try {
      const res = await api.post('/api/crawl/space', { spaceName: crawlSpaceInput });
      toast(res?.message || `Queued: ${crawlSpaceInput}`, 'success');
      setCrawlSpaceInput('');
    } catch { toast('Network error', 'error'); }
  };

  const submitChainCrawl = async () => {
    setChainCrawlModal(false);
    try {
      const countries = chainCrawlCountries ? chainCrawlCountries.split(',').map(c => c.trim()).filter(Boolean) : [];
      const res = await api.post('/api/chains/crawl/start', { chainSlug: chainCrawlSlug, countries });
      toast(res?.message || 'Chain crawl queued', res?.success !== false ? 'success' : 'error');
      setChainCrawlCountries('');
    } catch { toast('Network error', 'error'); }
  };

  const triggerSchedule = async (freq) => {
    try { const res = await api.post('/api/system/schedule/trigger', { frequency: freq }); toast(res?.message || 'Triggered', 'success'); } catch { toast('Failed', 'error'); }
  };
  const triggerStale = async () => { try { const res = await api.post('/api/system/schedule/trigger/stale'); toast(res?.message || 'Triggered', 'success'); } catch { toast('Failed', 'error'); } };
  const triggerEnrichment = async () => { try { const res = await api.post('/api/system/schedule/trigger/enrichment'); toast(res?.message || 'Triggered', 'success'); } catch { toast('Failed', 'error'); } };
  const retryFailed = async () => { try { const res = await api.post('/api/crawl/retry/failed'); toast(res?.message || 'Retrying', 'success'); } catch { toast('Failed', 'error'); } };
  const clearQueue = async () => { if (!confirm('⚠️ Cancel ALL queued and running jobs?')) return; try { const res = await api.post('/api/crawl/queue/clear'); toast(res?.message || 'Cleared', 'info'); } catch { toast('Failed', 'error'); } };
  const recalcScores = async () => { if (!confirm('Recalculate quality scores for all spaces?')) return; try { await api.post('/api/system/recalculate-scores'); toast('Recalculation started', 'info'); } catch { toast('Failed', 'error'); } };
  const vacuumLogs = async () => { if (!confirm('Delete all log files?')) return; try { const res = await api.post('/api/system/vacuum-logs'); toast(res?.message || 'Done', 'info'); } catch { toast('Failed', 'error'); } };
  const testEvent = async () => { try { await api.post('/api/events/test', {}); toast('Test event sent', 'info'); } catch { toast('Failed', 'error'); } };
  const triggerPhotoSync = async () => {
    try {
      const res = await api.post('/api/system/media/photo-sync/trigger');
      if (res?.success === false) {
        toast(res?.message || 'Sync already running', 'warning');
      } else {
        toast('Photo sync started in background', 'success');
        // Poll status after a short delay
        setTimeout(fetchHealth, 2000);
      }
    } catch { toast('Failed to trigger photo sync', 'error'); }
  };

  const tagExisting = async () => {
    if (!confirm('Tag all existing spaces with matching chain names?')) return;
    try { const res = await api.post('/api/chains/tag-existing'); toast(res?.message || 'Tagged', 'success'); } catch { toast('Failed', 'error'); }
  };

  const addScheduleCity = async () => {
    if (!addCity.name.trim()) return;
    try {
      const res = await api.post('/api/system/schedule/city', { name: addCity.name, frequency: addCity.frequency, priority: 3 });
      toast(res?.message || 'Added', 'success');
      setAddCity({ name: '', frequency: 'weekly' });
      fetchSchedule();
    } catch { toast('Failed', 'error'); }
  };

  const removeCity = async (name) => {
    if (!confirm(`Remove "${name}" from schedule?`)) return;
    try { await api.delete(`/api/system/schedule/city?name=${encodeURIComponent(name)}`); toast(`Removed: ${name}`, 'info'); fetchSchedule(); } catch { toast('Failed', 'error'); }
  };

  return (
    <div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid-2">
        {/* ── Command Center ────── */}
        <div className="card" style={{ position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--accent), var(--purple), transparent)', animation: 'scanLine 3s ease-in-out infinite' }} />
          <div className="card-header"><span className="card-title">⌘ Command Center</span><span className="card-icon"><Rocket size={18} /></span></div>

          <CmdGroup label="Crawl Operations">
            <button className="btn" onClick={() => setCrawlCityModal(true)}><Building2 size={13} /> Crawl City</button>
            <button className="btn" onClick={() => setCrawlSpaceModal(true)}><Dumbbell size={13} /> Crawl Space</button>
            <button className="btn" onClick={() => triggerSchedule('weekly')}><Calendar size={13} /> Weekly Run</button>
            <button className="btn" onClick={() => triggerSchedule('all')}><Globe2 size={13} /> All Cities</button>
          </CmdGroup>

          <CmdGroup label="Chain Operations">
            <button className="btn purple" onClick={() => { setChainCrawlSlug(chainsCache[0]?.slug || ''); setChainCrawlModal(true); }}>🔗 Crawl Chain</button>
            <button className="btn purple" onClick={tagExisting}>🏷️ Tag Existing</button>
          </CmdGroup>

          <CmdGroup label="Media Operations">
            <button
              className="btn"
              onClick={triggerPhotoSync}
              disabled={photoSync?.isLocked}
              style={{
                background: photoSync?.isLocked
                  ? 'rgba(139,92,246,0.15)'
                  : 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(109,40,217,0.35))',
                border: '1px solid rgba(139,92,246,0.5)',
                color: '#c4b5fd',
                boxShadow: photoSync?.isLocked ? 'none' : '0 0 12px rgba(139,92,246,0.25)',
                opacity: photoSync?.isLocked ? 0.6 : 1,
                cursor: photoSync?.isLocked ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <ImagePlay size={13} />
              {photoSync?.isLocked
                ? `Syncing… ${photoSync?.currentCycleProgress ?? 0}%`
                : `Sync Photos ${photoSync?.currentCycleProgress != null ? `(${photoSync.currentCycleProgress}%)` : ''}`
              }
            </button>
            {photoSync && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)', paddingTop: 2, gridColumn: '1 / -1' }}>
                Cycle {(photoSync.completedCycles || 0) + 1} &middot; {photoSync.currentCycleProcessed?.toLocaleString() ?? 0}/{photoSync.currentCycleTotalSpaces?.toLocaleString() ?? '?'} spaces
                {photoSync.lastRunAt && <> &middot; Last: {new Date(photoSync.lastRunAt).toLocaleDateString()}</>}
              </div>
            )}
          </CmdGroup>

          <CmdGroup label="Data Intelligence">
            <button className="btn" onClick={recalcScores}><Brain size={13} /> Recalc Scores</button>
            <button className="btn" onClick={triggerEnrichment}><BarChart3 size={13} /> Enrichment</button>
            <button className="btn" onClick={triggerStale}><RefreshCw size={13} /> Stale Refresh</button>
            <button className="btn" onClick={retryFailed}><RefreshCw size={13} /> Retry Failed</button>
          </CmdGroup>

          <CmdGroup label="System" last>
            <button className="btn" onClick={testEvent}><FlaskConical size={13} /> Test Event</button>
            <button className="btn danger" onClick={vacuumLogs}><Trash2 size={13} /> Vacuum Logs</button>
            <button className="btn danger" onClick={clearQueue}><XCircle size={13} /> Clear Queue</button>
          </CmdGroup>
        </div>

        {/* ── Schedule Editor ────── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📅 Schedule Editor</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{schedule.length} cities</span>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', scrollbarWidth: 'thin' }}>
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead><tr><th>City</th><th>Frequency</th><th>Priority</th><th></th></tr></thead>
              <tbody>
                {schedule.map(c => (
                  <tr key={c.name}>
                    <td style={{ color: 'var(--text-primary)' }}>{c.name}</td>
                    <td><span className={`freq-badge ${c.frequency}`}>{c.frequency}</span></td>
                    <td>P{c.priority}</td>
                    <td><button className="btn sm danger" onClick={() => removeCity(c.name)}>🗑️</button></td>
                  </tr>
                ))}
                {schedule.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No cities scheduled</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>City Name</span>
              <input className="input" placeholder="e.g. Pune, Maharashtra, India" value={addCity.name} onChange={e => setAddCity({...addCity, name: e.target.value})} onKeyDown={e => e.key === 'Enter' && addScheduleCity()} />
            </div>
            <div>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>Frequency</span>
              <select className="input" value={addCity.frequency} onChange={e => setAddCity({...addCity, frequency: e.target.value})}>
                <option>weekly</option><option>biweekly</option><option>monthly</option>
              </select>
            </div>
            <button className="btn primary sm" onClick={addScheduleCity}><Plus size={12} /> Add</button>
          </div>
        </div>
      </div>





      {/* ── Modals ────── */}
      <Modal open={crawlCityModal} onClose={() => setCrawlCityModal(false)} title="🏙️ Queue City Crawl">
        <textarea
          className="input"
          placeholder='e.g. "Mumbai, Maharashtra" OR JSON: ["City 1", "City 2"]'
          value={crawlCityInput}
          onChange={e => setCrawlCityInput(e.target.value)}
          rows={4}
          autoFocus
          style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12 }}
        />
        <div style={{ marginTop: 8 }}>
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const file = e.target.files[0];
              if (file) {
                const text = await file.text();
                setCrawlCityInput(text);
              }
            }}
            style={{ fontSize: 12, color: 'var(--text-muted)' }}
          />
        </div>
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => setCrawlCityModal(false)}>Cancel</button>
          <button className="btn primary" onClick={submitCrawlCity}>Queue Crawl</button>
        </div>
      </Modal>

      <Modal open={crawlSpaceModal} onClose={() => setCrawlSpaceModal(false)} title="🏋️ Queue Specific Space">
        <input className="input" placeholder="e.g. Gold's Space Andheri Mumbai" value={crawlSpaceInput} onChange={e => setCrawlSpaceInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitCrawlSpace()} autoFocus />
        <div className="modal-actions">
          <button className="btn" onClick={() => setCrawlSpaceModal(false)}>Cancel</button>
          <button className="btn primary" onClick={submitCrawlSpace}>Queue Space</button>
        </div>
      </Modal>

      <Modal open={chainCrawlModal} onClose={() => setChainCrawlModal(false)} title="🔗 Crawl Chain">
        <select className="input" value={chainCrawlSlug} onChange={e => setChainCrawlSlug(e.target.value)}>
          {chainsCache.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
        <input className="input" placeholder="Countries (optional, comma-sep): IN, US, AU" value={chainCrawlCountries} onChange={e => setChainCrawlCountries(e.target.value)} />
        <div className="modal-actions">
          <button className="btn" onClick={() => setChainCrawlModal(false)}>Cancel</button>
          <button className="btn primary" onClick={submitChainCrawl}><Rocket size={14} /> Start Crawl</button>
        </div>
      </Modal>
    </div>
  );
}

function CmdGroup({ label, children, last }) {
  return (
    <div style={{ marginBottom: last ? 0 : 16 }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}<span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, var(--border), transparent)' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}
