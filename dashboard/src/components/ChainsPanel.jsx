import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Tag, Rocket, ShieldCheck } from 'lucide-react';
import ChainCard from './ChainCard';
import GymRow from './GymRow';
import Modal from './Modal';
import Pagination from './Pagination';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

export default function ChainsPanel({ onSelectGym }) {
  const { toast, chainsCache, setChainsCache } = useApp();
  
  // Chain gyms panel
  const [selectedChainSlug, setSelectedChainSlug] = useState(null);
  const [selectedChainName, setSelectedChainName] = useState('');
  const [chainGyms, setChainGyms] = useState([]);
  const [chainGymsTotal, setChainGymsTotal] = useState(0);
  const [chainGymsPage, setChainGymsPage] = useState(1);
  const [chainGymsCountry, setChainGymsCountry] = useState('');

  // Modals
  const [crawlModalOpen, setCrawlModalOpen] = useState(false);
  const [crawlSlug, setCrawlSlug] = useState('');
  const [crawlCountries, setCrawlCountries] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newChain, setNewChain] = useState({ name: '', slug: '', aliases: '', website: '' });

  const fetchChains = async () => {
    try {
      const res = await api.get('/api/chains');
      if (res?.success) setChainsCache(res.chains || []);
    } catch {}
  };

  const handleCrawl = (slug, name) => {
    setCrawlSlug(slug);
    setCrawlModalOpen(true);
  };

  const submitCrawl = async () => {
    setCrawlModalOpen(false);
    try {
      const countries = crawlCountries ? crawlCountries.split(',').map(c => c.trim()).filter(Boolean) : [];
      const res = await api.post('/api/chains/crawl/start', { chainSlug: crawlSlug, countries });
      toast(res?.message || 'Chain crawl queued', res?.success !== false ? 'success' : 'error');
      setTimeout(fetchChains, 1000);
    } catch { toast('Network error', 'error'); }
    setCrawlCountries('');
  };

  const handleTag = async (slug) => {
    try {
      const res = await api.post(`/api/chains/${slug}/tag`);
      toast(res?.message || 'Tagged', 'success');
      setTimeout(fetchChains, 500);
    } catch { toast('Failed', 'error'); }
  };

  const handleTagAll = async () => {
    if (!(await confirm('Tag all existing gyms with matching chain names?'))) return;
    try {
      const res = await api.post('/api/chains/tag-existing');
      toast(res?.message || 'Tagged', 'success');
      setTimeout(fetchChains, 500);
    } catch { toast('Failed', 'error'); }
  };

  const submitAddChain = async () => {
    if (!newChain.name || !newChain.slug) { toast('Name and slug required', 'error'); return; }
    setAddModalOpen(false);
    try {
      const body = {
        name: newChain.name,
        slug: newChain.slug,
        aliases: newChain.aliases ? newChain.aliases.split(',').map(a => a.trim()) : [],
        website: newChain.website,
      };
      const res = await api.post('/api/chains', body);
      toast(res?.message || 'Chain created', 'success');
      setNewChain({ name: '', slug: '', aliases: '', website: '' });
      setTimeout(fetchChains, 500);
    } catch { toast('Failed', 'error'); }
  };

  const viewChainGyms = async (slug, name) => {
    setSelectedChainSlug(slug);
    setSelectedChainName(name);
    setChainGymsPage(1);
    setChainGymsCountry('');
    await loadChainGyms(slug, 1, '');
  };

  const loadChainGyms = async (slug, p = chainGymsPage, country = chainGymsCountry) => {
    const params = new URLSearchParams({ page: p, limit: 10 });
    if (country) params.set('country', country);
    try {
      const res = await api.get(`/api/chains/${slug || selectedChainSlug}/gyms?${params}`);
      if (res?.success) {
        setChainGyms(res.gyms || []);
        setChainGymsTotal(res.total || 0);
      }
    } catch {}
  };

  return (
    <div className="card" style={{ marginBottom: 24, overflow: 'hidden' }}>
      <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
        <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
          <div style={{ padding: 6, background: 'rgba(139, 92, 246, 0.1)', borderRadius: 8, border: '1px solid rgba(139, 92, 246, 0.2)' }}>
            <ShieldCheck size={18} color="#8b5cf6" />
          </div>
          Reconnaissance Targets
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn sm" onClick={handleTagAll}><Tag size={12} /> Auto-Tag Network</button>
          <button className="btn sm primary" onClick={() => setAddModalOpen(true)}><Plus size={12} /> Add Target</button>
        </div>
      </div>
      
      <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 4, display: 'flex', flexDirection: 'column', gap: 8 }} className="custom-scrollbar">
        {chainsCache.map(c => (
          <ChainCard key={c.slug} chain={c} onCrawl={handleCrawl} onViewGyms={viewChainGyms} onTag={handleTag} />
        ))}
        {chainsCache.length === 0 && <div className="empty-state" style={{ width: '100%' }}>No target networks registered</div>}
      </div>

      <AnimatePresence>
        {selectedChainSlug && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-surface)', marginTop: 8 }}
          >
            <div style={{ padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Network Nodes: {selectedChainName}</span>
                <button className="btn sm" onClick={() => setSelectedChainSlug(null)}>✕ Close</button>
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
                <input className="input" type="text" placeholder="Filter by region..." value={chainGymsCountry} onChange={e => setChainGymsCountry(e.target.value)} style={{ maxWidth: 240 }} />
                <button className="btn secondary sm" onClick={() => { setChainGymsPage(1); loadChainGyms(selectedChainSlug, 1, chainGymsCountry); }}>Apply Filter</button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{chainGymsTotal} active nodes</span>
              </div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }} className="custom-scrollbar">
                {chainGyms.length > 0 ? chainGyms.map(g => (
                  <GymRow key={g._id} gym={g} onClick={onSelectGym} />
                )) : <div className="empty-state" style={{ padding: 20 }}>No locations discovered yet</div>}
              </div>
              <div style={{ marginTop: 12 }}>
                <Pagination current={chainGymsPage} total={Math.ceil(chainGymsTotal / 10)} onPage={p => { setChainGymsPage(p); loadChainGyms(selectedChainSlug, p, chainGymsCountry); }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal open={crawlModalOpen} onClose={() => setCrawlModalOpen(false)} title="Initialize Network Reconnaissance">
        <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-muted)' }}>Targeting: <strong style={{ color: 'var(--text-primary)' }}>{chainsCache.find(c => c.slug === crawlSlug)?.name}</strong></div>
        <input className="input" type="text" placeholder="Limit to regions (e.g. IN, US, UK)" value={crawlCountries} onChange={e => setCrawlCountries(e.target.value)} />
        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button className="btn secondary" onClick={() => setCrawlModalOpen(false)}>Abort</button>
          <button className="btn primary" onClick={submitCrawl} style={{ background: 'var(--accent)' }}><Rocket size={14} /> Execute Scan</button>
        </div>
      </Modal>

      <Modal open={addModalOpen} onClose={() => setAddModalOpen(false)} title="Register Target Network">
        <input className="input" placeholder="Organization Name (e.g. Equinox)" value={newChain.name} onChange={e => setNewChain({...newChain, name: e.target.value})} style={{ marginBottom: 12 }} />
        <input className="input" placeholder="System ID (e.g. equinox)" value={newChain.slug} onChange={e => setNewChain({...newChain, slug: e.target.value})} style={{ marginBottom: 12 }} />
        <input className="input" placeholder="Known Aliases (comma separated)" value={newChain.aliases} onChange={e => setNewChain({...newChain, aliases: e.target.value})} style={{ marginBottom: 12 }} />
        <input className="input" placeholder="Primary Domain" value={newChain.website} onChange={e => setNewChain({...newChain, website: e.target.value})} />
        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button className="btn secondary" onClick={() => setAddModalOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={submitAddChain}>Register Target</button>
        </div>
      </Modal>
    </div>
  );
}
