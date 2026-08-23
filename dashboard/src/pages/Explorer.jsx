import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, X, Download, Star, MapPin, Target, Zap,
  ChevronLeft, ChevronRight, SlidersHorizontal, Database,
} from 'lucide-react';
import GymDrawer from '../components/GymDrawer';
import { api, getBaseUrl } from '../api/client';
import { useApp } from '../context/AppContext';

const LIMIT = 25;
const SORT_OPTIONS = [
  { value: 'qualityScore', label: 'Quality' },
  { value: 'rating',       label: 'Rating'  },
  { value: 'totalReviews', label: 'Reviews' },
  { value: 'createdAt',    label: 'Newest'  },
  { value: 'name',         label: 'Name'    },
];

const SOURCE_COLORS = {
  google_maps:      '#4285F4',
  justdial:         '#F05A28',
  osm:              '#7EBC6F',
  yelp:             '#D32323',
  official_website: '#8B5CF6',
};
const SOURCE_SHORT = {
  google_maps: 'G', justdial: 'JD', osm: 'OSM', yelp: 'Y', official_website: 'W',
};

function QualityDot({ score }) {
  const color = score >= 80 ? '#10B981' : score >= 60 ? '#7C3AED' : score >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 12, fontFamily: 'var(--mono)', color, fontWeight: 700,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {score ?? '—'}
    </span>
  );
}

function StageBar({ stage }) {
  const s = stage ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ display: 'flex', gap: 2 }}>
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i} style={{
            width: 4, height: 10, borderRadius: 2,
            background: i < s ? '#7C3AED' : '#1A1A1A',
            transition: 'background 0.2s',
          }} />
        ))}
      </div>
      <span style={{ fontSize: 10, color: '#52525B', fontFamily: 'var(--mono)' }}>{s}/7</span>
    </div>
  );
}

function SourceTags({ sources = [] }) {
  if (!sources.length) return null;
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {sources.slice(0, 3).map(s => (
        <span key={s} title={s} style={{
          width: 18, height: 18, borderRadius: 4, fontSize: 9, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: (SOURCE_COLORS[s] || '#3F3F46') + '22',
          color: SOURCE_COLORS[s] || '#71717A',
          border: `1px solid ${(SOURCE_COLORS[s] || '#3F3F46')}44`,
        }}>
          {SOURCE_SHORT[s] || '?'}
        </span>
      ))}
    </div>
  );
}

export default function Explorer() {
  const { toast, chainsCache } = useApp();

  const [search, setSearch]           = useState('');
  const [city, setCity]               = useState('');
  const [category, setCategory]       = useState('');
  const [rating, setRating]           = useState('');
  const [sort, setSort]               = useState('qualityScore');
  const [showFilters, setShowFilters] = useState(false);

  const [spaces, setSpaces]         = useState([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [pages, setPages]           = useState(1);
  const [loading, setLoading]       = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [cities, setCities]         = useState([]);
  const [categories, setCategories] = useState([]);
  const [searchMs, setSearchMs]     = useState(null);

  const debounceRef = useRef(null);

  const fetchSpaces = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ limit: LIMIT, page: p });
    if (search)   params.set('search', search);
    if (city)     params.set('city', city);
    if (category) params.set('category', category);
    if (rating)   params.set('minRating', rating);
    if (sort)     params.set('sortBy', sort);

    try {
      const res = await api.get(`/api/spaces?${params}`);
      if (res?.success) {
        setSpaces(res.spaces || res.gyms || []);
        setTotal(res.total || 0);
        setPage(res.page || 1);
        setPages(res.pages || 1);
        setSearchMs(res.searchTime ?? null);
      }
    } catch (e) {
      toast('Failed to fetch spaces', 'error');
    } finally {
      setLoading(false);
    }
  }, [search, city, category, rating, sort, toast]);

  // Debounced fetch on filter change
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSpaces(1), 350);
    return () => clearTimeout(debounceRef.current);
  }, [fetchSpaces]);

  // Load filter options once
  useEffect(() => {
    api.get('/api/spaces/cities').then(r => r?.success && setCities(r.cities || [])).catch(() => {});
    api.get('/api/spaces/stats').then(r => r?.success && setCategories(r.categories || [])).catch(() => {});
  }, []);

  const handleExport = () => {
    const a = document.createElement('a');
    a.href = `${getBaseUrl()}/api/spaces/export`;
    a.download = 'spaces-export.json';
    a.click();
    toast('Export started…', 'info');
  };

  const clearAll = () => {
    setSearch(''); setCity(''); setCategory(''); setRating(''); setSort('qualityScore');
  };

  const hasFilters = search || city || category || rating || sort !== 'qualityScore';

  const COL = { name: '32%', quality: '8%', rating: '9%', reviews: '9%', city: '14%', category: '12%', stage: '9%', sources: '7%' };

  return (
    <div className="container">
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Database size={18} style={{ color: '#7C3AED' }} />
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, letterSpacing: '-0.3px' }}>
            Space Explorer
          </h1>
          <span style={{ fontSize: 12, color: '#52525B', fontFamily: 'var(--mono)', background: '#111', border: '1px solid #222', padding: '2px 8px', borderRadius: 6 }}>
            {total.toLocaleString()} spaces
          </span>
        </div>
        <button className="btn sm" onClick={handleExport}>
          <Download size={12} /> Export
        </button>
      </div>

      {/* ── Search + Filter bar ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        {/* Search input */}
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#52525B', pointerEvents: 'none' }} />
          <input
            style={{
              width: '100%', padding: '9px 36px', borderRadius: 8, fontSize: 13,
              border: '1px solid #222', background: '#0A0A0A', color: '#FAFAFA',
              outline: 'none', transition: 'border-color 0.15s',
            }}
            placeholder="Search spaces by name, area, or address…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setSearch('')}
            onFocus={e => e.target.style.borderColor = '#7C3AED'}
            onBlur={e => e.target.style.borderColor = '#222'}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#52525B', padding: 2 }}>
              <X size={13} />
            </button>
          )}
        </div>

        {/* Sort */}
        <select
          value={sort}
          onChange={e => setSort(e.target.value)}
          style={{ padding: '9px 10px', borderRadius: 8, fontSize: 12, border: '1px solid #222', background: '#0A0A0A', color: '#A1A1AA', cursor: 'pointer' }}
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {/* Filter toggle */}
        <button
          className={`btn sm${showFilters ? ' accent' : ''}`}
          onClick={() => setShowFilters(v => !v)}
          style={showFilters ? { borderColor: 'rgba(124,58,237,0.5)', color: '#A78BFA', background: 'rgba(124,58,237,0.12)' } : {}}
        >
          <SlidersHorizontal size={13} />
          Filters
          {hasFilters && !showFilters && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7C3AED', marginLeft: 2 }} />}
        </button>

        {hasFilters && (
          <button className="btn sm" onClick={clearAll} title="Clear all filters">
            <X size={12} />
          </button>
        )}
      </div>

      {/* ── Expanded filter panel ── */}
      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden', marginBottom: 12 }}
          >
            <div style={{ display: 'flex', gap: 10, padding: '12px 16px', background: '#0A0A0A', borderRadius: 8, border: '1px solid #1A1A1A' }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 10, color: '#52525B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>City / Area</label>
                <select value={city} onChange={e => setCity(e.target.value)} style={selectStyle}>
                  <option value="">All Areas</option>
                  {cities.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 10, color: '#52525B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>Category</label>
                <select value={category} onChange={e => setCategory(e.target.value)} style={selectStyle}>
                  <option value="">All Categories</option>
                  {categories.map(c => <option key={c._id} value={c._id}>{c._id} ({c.count})</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 10, color: '#52525B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 5 }}>Min Rating</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['', '3', '3.5', '4', '4.5'].map(r => (
                    <button key={r} onClick={() => setRating(r)} style={{
                      padding: '5px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${rating === r ? '#7C3AED' : '#222'}`,
                      background: rating === r ? 'rgba(124,58,237,0.15)' : '#111',
                      color: rating === r ? '#A78BFA' : '#71717A',
                    }}>{r ? `${r}+` : 'Any'}</button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Table ── */}
      <div style={{ border: '1px solid #1A1A1A', borderRadius: 10, overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', background: '#0A0A0A', borderBottom: '1px solid #1A1A1A' }}>
          <ColHead label="Name"     width={COL.name} />
          <ColHead label="Quality"  width={COL.quality} />
          <ColHead label="Rating"   width={COL.rating} />
          <ColHead label="Reviews"  width={COL.reviews} />
          <ColHead label="City"     width={COL.city} />
          <ColHead label="Category" width={COL.category} />
          <ColHead label="Stage"    width={COL.stage} />
          <ColHead label="Sources"  width={COL.sources} />
        </div>

        {/* Rows */}
        {loading ? (
          <div style={{ padding: '32px 14px' }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} style={{ height: 40, background: '#0A0A0A', borderRadius: 6, marginBottom: 6, opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        ) : spaces.length === 0 ? (
          <div style={{ padding: '48px 14px', textAlign: 'center', color: '#52525B', fontSize: 13 }}>
            No spaces found{hasFilters ? ' — try clearing filters' : ''}
          </div>
        ) : (
          <div>
            {spaces.map((space, idx) => (
              <SpaceRow
                key={space._id || space.opgId || idx}
                space={space}
                onClick={() => setSelectedId(space._id || space.opgId)}
                COL={COL}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, padding: '0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#52525B' }}>
          <span style={{ fontFamily: 'var(--mono)' }}>{total.toLocaleString()} total</span>
          {searchMs != null && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Zap size={10} style={{ color: '#7C3AED' }} />
              {searchMs}ms
            </span>
          )}
        </div>
        {pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="btn sm" onClick={() => fetchSpaces(page - 1)} disabled={page <= 1}>
              <ChevronLeft size={13} />
            </button>
            <span style={{ fontSize: 12, color: '#71717A', fontFamily: 'var(--mono)', minWidth: 70, textAlign: 'center' }}>
              {page} / {pages}
            </span>
            <button className="btn sm" onClick={() => fetchSpaces(page + 1)} disabled={page >= pages}>
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>

      {/* ── Drawer ── */}
      {selectedId && <GymDrawer gymId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function ColHead({ label, width }) {
  return (
    <div style={{ width, flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#52525B', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
      {label}
    </div>
  );
}

function SpaceRow({ space, onClick, COL }) {
  const [hov, setHov] = useState(false);

  const rating = space.rating ?? null;
  const stage  = space.enrichment?.stage ?? 0;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', padding: '10px 14px',
        background: hov ? '#0D0D0D' : 'transparent',
        borderBottom: '1px solid #111',
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      {/* Name */}
      <div style={{ width: COL.name, paddingRight: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#FAFAFA', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {space.name || '—'}
        </div>
        {space.primaryCategorySlug && (
          <div style={{ fontSize: 10, color: '#52525B', marginTop: 1 }}>{space.primaryCategorySlug.replace(/-/g, ' ')}</div>
        )}
      </div>

      {/* Quality */}
      <div style={{ width: COL.quality }}>
        <QualityDot score={space.qualityScore} />
      </div>

      {/* Rating */}
      <div style={{ width: COL.rating, display: 'flex', alignItems: 'center', gap: 4 }}>
        {rating != null ? (
          <>
            <Star size={11} style={{ color: '#F59E0B', fill: '#F59E0B', flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: '#E4E4E7' }}>{rating.toFixed(1)}</span>
          </>
        ) : <span style={{ fontSize: 12, color: '#3F3F46' }}>—</span>}
      </div>

      {/* Reviews */}
      <div style={{ width: COL.reviews }}>
        <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: '#71717A' }}>
          {space.totalReviews ? space.totalReviews.toLocaleString() : '—'}
        </span>
      </div>

      {/* City */}
      <div style={{ width: COL.city, paddingRight: 8 }}>
        {space.city || space.areaName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#71717A', overflow: 'hidden' }}>
            <MapPin size={10} style={{ flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {space.city || space.areaName}
            </span>
          </div>
        ) : <span style={{ fontSize: 12, color: '#3F3F46' }}>—</span>}
      </div>

      {/* Category */}
      <div style={{ width: COL.category, paddingRight: 8 }}>
        <span style={{ fontSize: 11, color: '#71717A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', textTransform: 'capitalize' }}>
          {space.primaryCategorySlug?.replace(/-/g, ' ') || '—'}
        </span>
      </div>

      {/* Enrichment stage */}
      <div style={{ width: COL.stage }}>
        <StageBar stage={stage} />
      </div>

      {/* Sources */}
      <div style={{ width: COL.sources }}>
        <SourceTags sources={space.sources || []} />
      </div>
    </div>
  );
}

const selectStyle = {
  width: '100%', padding: '7px 10px', borderRadius: 7, fontSize: 12,
  border: '1px solid #222', background: '#111', color: '#A1A1AA', cursor: 'pointer',
};
