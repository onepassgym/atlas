import { useState, useEffect } from 'react';
import { MapPin, Rocket, Trash2, Plus } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

export default function ScheduleEditor() {
  const { toast } = useApp();
  const [schedule, setSchedule] = useState([]);
  const [addCity, setAddCity] = useState({ name: '', frequency: 'weekly' });

  const fetchSchedule = async () => {
    try {
      const res = await api.get('/api/system/schedule');
      if (res?.success) setSchedule(res.schedule?.cities || []);
    } catch {}
  };

  useEffect(() => {
    fetchSchedule();
  }, []);

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
    try {
      await api.delete('/api/system/schedule/city', { data: { name } });
      toast('Removed from schedule', 'info');
      fetchSchedule();
    } catch { toast('Failed to remove', 'error'); }
  };

  const runCityNow = async (cityName) => {
    try {
      const res = await api.post('/api/crawl/city', { cityName, force: true });
      toast(res?.message || `Queued ${cityName}`, res?.success !== false ? 'success' : 'error');
    } catch {
      toast('Failed to queue city', 'error');
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">📅 Schedule Editor</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{schedule.length} cities</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', paddingRight: 4 }} className="custom-scrollbar">
        {schedule.map(c => (
          <div key={c.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6' }}>
                <MapPin size={16} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span className={`freq-badge ${c.frequency}`} style={{ fontSize: 10, padding: '2px 6px' }}>{c.frequency}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>Priority {c.priority}</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm primary" onClick={() => runCityNow(c.name)} title="Run Now">
                <Rocket size={12} /> Run
              </button>
              <button className="btn sm danger" onClick={() => removeCity(c.name)} title="Remove">
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
        {schedule.length === 0 && <div className="empty-state">No cities scheduled</div>}
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
  );
}
