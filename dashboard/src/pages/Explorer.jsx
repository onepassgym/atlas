import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, X, Download, Filter, ChevronDown, ChevronUp,
  MapPin, Star, MessageCircle, Target, Clock, Zap,
  Building2, Tag, BarChart3, SlidersHorizontal, Sparkles,
  ArrowUpDown, TrendingUp, Hash
} from 'lucide-react';
import GymRow from '../components/GymRow';
import GymDrawer from '../components/GymDrawer';
import Pagination from '../components/Pagination';
import Skeleton from '../components/Skeleton';
import { api, getBaseUrl } from '../api/client';
import { useApp } from '../context/AppContext';

function formatCategory(cat) {
  if (!cat || cat === 'undefined' || cat === 'unknown') return 'Unknown';
  return String(cat).split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const LIMIT = 20;
const RECENT_SEARCHES_KEY = 'atlas_recent_searches';

function getRecentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]').slice(0, 8); }
  catch { return []; }
}
function saveRecentSearch(term) {
  if (!term || term.length < 2) return;
  const recent = getRecentSearches().filter(s => s !== term);
  recent.unshift(term);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recent.slice(0, 8)));
}
function clearRecentSearches() {
  localStorage.removeItem(RECENT_SEARCHES_KEY);
}

export default function Explorer() {
  const { toast, chainsCache } = useApp();
  
  // ── Search State ──
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState(getRecentSearches);
  
  // ── Filter State ──
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [chain, setChain] = useState('');
  const [rating, setRating] = useState('');
  const [sort, setSort] = useState('qualityScore');
  const [minReviews, setMinReviews] = useState('');
  const [chainOnly, setChainOnly] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  // ── Data State ──
  const [gyms, setGyms] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selectedGym, setSelectedGym] = useState(null);
  const [categories, setCategories] = useState([]);
  const [cities, setCities] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [searchTime, setSearchTime] = useState(null);
  const [searchMode, setSearchMode] = useState(null);

  const searchInputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const searchAbortRef = useRef(null);

  // ── Active filter count ──
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (city) count++;
    if (category) count++;
    if (chain) count++;
    if (rating) count++;
    if (minReviews) count++;
    if (chainOnly) count++;
    if (sort !== 'qualityScore') count++;
    return count;
  }, [city, category, chain, rating, minReviews, chainOnly, sort]);

  // ── Active filter chips ──
  const activeFilters = useMemo(() => {
    const chips = [];
    if (city) chips.push({ key: 'city', label: `City: ${city}`, clear: () => setCity('') });
    if (category) chips.push({ key: 'category', label: `Category: ${formatCategory(category)}`, clear: () => setCategory('') });
    if (chain) {
      const chainObj = chainsCache.find(c => c.slug === chain);
      chips.push({ key: 'chain', label: `Chain: ${chainObj?.name || chain}`, clear: () => setChain('') });
    }
    if (rating) chips.push({ key: 'rating', label: `Rating: ${rating}+`, clear: () => setRating('') });
    if (minReviews) chips.push({ key: 'minReviews', label: `Min ${minReviews} reviews`, clear: () => setMinReviews('') });
    if (chainOnly) chips.push({ key: 'chainOnly', label: 'Chain Only', clear: () => setChainOnly(false) });
    return chips;
  }, [city, category, chain, rating, minReviews, chainOnly, chainsCache]);

  // ── Fetch gyms ──
  const searchGyms = useCallback(async (p = 1) => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('limit', LIMIT);
    params.set('page', p);
    if (search) params.set('search', search);
    if (city) params.set('city', city);
    if (category) params.set('category', category);
    if (chain) params.set('chainSlug', chain);
    if (rating) params.set('minRating', rating);
    if (sort) params.set('sortBy', sort);
    if (minReviews) params.set('minReviews', minReviews);
    if (chainOnly) params.set('isChainMember', 'true');

    try {
      const res = await api.get(`/api/spaces?${params.toString()}`);
      if (res?.success) {
        setGyms(res.gyms || []);
        setTotal(res.total || 0);
        setPage(res.page || 1);
        setPages(res.pages || 1);
        setSearchTime(res.searchTime || null);
        setSearchMode(res.searchMode || null);
      }
    } catch (e) {
      toast('Failed to fetch gyms', 'error');
    } finally {
      setLoading(false);
    }
  }, [search, city, category, chain, rating, sort, minReviews, chainOnly, toast]);

  // ── Fetch suggestions ──
  const fetchSuggestions = useCallback(async (query) => {
    if (query.length < 2) { setSuggestions([]); return; }
    
    if (searchAbortRef.current) searchAbortRef.current.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    
    setSuggestionsLoading(true);
    try {
      const res = await api.get(`/api/spaces/suggestions?q=${encodeURIComponent(query)}`);
      if (!controller.signal.aborted && res?.success) {
        setSuggestions(res.suggestions || []);
      }
    } catch (e) {
      if (!controller.signal.aborted) setSuggestions([]);
    } finally {
      if (!controller.signal.aborted) setSuggestionsLoading(false);
    }
  }, []);

  // ── Load filter options once ──
  useEffect(() => {
    if (loaded) return;
    setLoaded(true);
    api.get('/api/spaces/stats').then(res => {
      if (res?.success) {
        setCategories(res.stats?.byCategory || []);
        setCities((res.stats?.topCities || []).map(c => ({ name: c._id, count: c.count })));
      }
    }).catch(() => {});
    // Also load all cities
    api.get('/api/spaces/cities').then(res => {
      if (res?.success) setCities(res.cities || []);
    }).catch(() => {});
    searchGyms(1);
  }, [loaded, searchGyms]);

  // ── Debounced search + suggestions ──
  const searchRef = useRef(search);
  useEffect(() => {
    if (search === searchRef.current) return;
    searchRef.current = search;

    // Fetch suggestions immediately (debounced shorter)
    const sugHandler = setTimeout(() => fetchSuggestions(search), 200);
    
    // Trigger main search with longer debounce
    if (search.length >= 2 || search.length === 0) {
      const handler = setTimeout(() => searchGyms(1), 500);
      return () => { clearTimeout(handler); clearTimeout(sugHandler); };
    }
    return () => clearTimeout(sugHandler);
  }, [search, searchGyms, fetchSuggestions]);

  // ── Close suggestions on outside click ──
  useEffect(() => {
    function handleClick(e) {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target) &&
          searchInputRef.current && !searchInputRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ── Handlers ──
  const handleSearchSubmit = (term) => {
    const value = term || search;
    if (value) saveRecentSearch(value);
    setRecentSearches(getRecentSearches());
    setShowSuggestions(false);
    if (term) setSearch(term);
    setTimeout(() => searchGyms(1), 0);
  };

  const handleSuggestionClick = (suggestion) => {
    if (suggestion.type === 'gym') {
      setSelectedGym(suggestion.id);
      setShowSuggestions(false);
    } else if (suggestion.type === 'area') {
      setCity(suggestion.name);
      setSearch('');
      setShowSuggestions(false);
      setTimeout(() => searchGyms(1), 0);
    } else if (suggestion.type === 'chain') {
      setChain(suggestion.slug || '');
      setSearch('');
      setShowSuggestions(false);
      setTimeout(() => searchGyms(1), 0);
    }
  };

  const clearFilters = () => {
    setSearch(''); setCity(''); setCategory(''); setChain(''); setRating('');
    setSort('qualityScore'); setMinReviews(''); setChainOnly(false);
    setTimeout(() => searchGyms(1), 0);
  };

  const removeFilter = (key) => {
    const chip = activeFilters.find(f => f.key === key);
    if (chip) { chip.clear(); setTimeout(() => searchGyms(1), 50); }
  };

  const handleExport = () => {
    const a = document.createElement('a');
    a.href = `${getBaseUrl()}/api/spaces/export`;
    a.download = 'gyms-export.json';
    a.click();
    toast('Export started…', 'info');
  };

  const handleFilterChange = (setter) => (value) => {
    setter(value);
    setTimeout(() => searchGyms(1), 0);
  };

  return (
    <motion.div className="container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      
      {/* ═══════════════════════════════════════════════════════
          SEARCH HERO BAR
          ═══════════════════════════════════════════════════════ */}
      <div className="explorer-search-hero">
        <div className="explorer-search-header">
          <div className="explorer-search-title">
            <Sparkles size={20} className="explorer-search-icon" />
            <span>Gym Explorer</span>
          </div>
          <div className="explorer-search-actions">
            <button className="btn sm" onClick={handleExport} id="export-btn">
              <Download size={13} /> Export
            </button>
          </div>
        </div>

        <div className="explorer-search-container" ref={searchInputRef}>
          <div className="explorer-search-input-wrap">
            <Search size={18} className="explorer-search-lens" />
            <input
              className="explorer-search-input"
              type="text"
              placeholder="Search gyms by name, area, chain, or address…"
              value={search}
              onChange={e => { setSearch(e.target.value); setShowSuggestions(true); }}
              onFocus={() => setShowSuggestions(true)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSearchSubmit();
                if (e.key === 'Escape') setShowSuggestions(false);
              }}
              id="gym-search-input"
              autoComplete="off"
            />
            {search && (
              <button className="explorer-search-clear" onClick={() => { setSearch(''); searchInputRef.current?.querySelector('input')?.focus(); }}>
                <X size={14} />
              </button>
            )}
            <button className="explorer-search-btn" onClick={() => handleSearchSubmit()}>
              <Zap size={14} /> Search
            </button>
          </div>

          {/* ── Suggestions Dropdown ── */}
          <AnimatePresence>
            {showSuggestions && (search.length >= 2 || recentSearches.length > 0) && (
              <motion.div
                className="explorer-suggestions"
                ref={suggestionsRef}
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.2 }}
              >
                {/* Recent Searches */}
                {search.length < 2 && recentSearches.length > 0 && (
                  <div className="suggestion-section">
                    <div className="suggestion-section-header">
                      <span><Clock size={12} /> Recent Searches</span>
                      <button className="suggestion-clear-btn" onClick={() => { clearRecentSearches(); setRecentSearches([]); }}>Clear</button>
                    </div>
                    {recentSearches.map((term, i) => (
                      <div key={i} className="suggestion-item recent" onClick={() => { setSearch(term); handleSearchSubmit(term); }}>
                        <Clock size={13} className="suggestion-item-icon" />
                        <span>{term}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Live Suggestions */}
                {search.length >= 2 && (
                  <>
                    {suggestionsLoading && (
                      <div className="suggestion-loading">
                        <div className="suggestion-loading-dot" />
                        <div className="suggestion-loading-dot" />
                        <div className="suggestion-loading-dot" />
                      </div>
                    )}
                    {!suggestionsLoading && suggestions.length === 0 && (
                      <div className="suggestion-empty">No suggestions found</div>
                    )}
                    {!suggestionsLoading && suggestions.filter(s => s.type === 'gym').length > 0 && (
                      <div className="suggestion-section">
                        <div className="suggestion-section-header"><span><Building2 size={12} /> Gyms</span></div>
                        {suggestions.filter(s => s.type === 'gym').map((s, i) => (
                          <div key={i} className="suggestion-item gym" onClick={() => handleSuggestionClick(s)}>
                            {s.thumbnail ? (
                              <img src={s.thumbnail} alt="" className="suggestion-thumb" />
                            ) : (
                              <div className="suggestion-thumb-placeholder"><Building2 size={14} /></div>
                            )}
                            <div className="suggestion-item-content">
                              <div className="suggestion-item-name">{s.name}</div>
                              <div className="suggestion-item-meta">
                                {s.area && <span><MapPin size={10} /> {s.area}</span>}
                                {s.rating && <span><Star size={10} /> {s.rating?.toFixed(1)}</span>}
                                {s.reviews > 0 && <span><MessageCircle size={10} /> {s.reviews}</span>}
                              </div>
                            </div>
                            {s.quality > 0 && (
                              <div className="suggestion-quality">
                                <Target size={10} /> {s.quality}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {!suggestionsLoading && suggestions.filter(s => s.type === 'area').length > 0 && (
                      <div className="suggestion-section">
                        <div className="suggestion-section-header"><span><MapPin size={12} /> Areas</span></div>
                        {suggestions.filter(s => s.type === 'area').map((s, i) => (
                          <div key={i} className="suggestion-item area" onClick={() => handleSuggestionClick(s)}>
                            <MapPin size={14} className="suggestion-item-icon" />
                            <div className="suggestion-item-content">
                              <div className="suggestion-item-name">{s.name}</div>
                              <div className="suggestion-item-meta">
                                <span>{s.count} gyms</span>
                                {s.avgRating && <span><Star size={10} /> {s.avgRating} avg</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {!suggestionsLoading && suggestions.filter(s => s.type === 'chain').length > 0 && (
                      <div className="suggestion-section">
                        <div className="suggestion-section-header"><span><Building2 size={12} /> Chains</span></div>
                        {suggestions.filter(s => s.type === 'chain').map((s, i) => (
                          <div key={i} className="suggestion-item chain" onClick={() => handleSuggestionClick(s)}>
                            <Building2 size={14} className="suggestion-item-icon" />
                            <div className="suggestion-item-content">
                              <div className="suggestion-item-name">{s.name}</div>
                              <div className="suggestion-item-meta"><span>{s.count} locations</span></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Search Stats Line ── */}
        <div className="explorer-search-stats">
          <div className="explorer-search-stats-left">
            <span className="explorer-result-count">
              <Hash size={12} />
              <strong>{total.toLocaleString()}</strong> gyms found
            </span>
            {searchTime != null && (
              <span className="explorer-search-time">
                <Zap size={11} /> {searchTime}ms
              </span>
            )}
            {searchMode && search && (
              <span className={`explorer-search-mode ${searchMode}`}>
                {searchMode === 'text' ? 'Relevance' : searchMode === 'fuzzy' ? 'Fuzzy' : 'Filter'}
              </span>
            )}
          </div>
          <div className="explorer-search-stats-right">
            <span className="explorer-page-info">
              Page {page} / {pages}
            </span>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          ACTIVE FILTER CHIPS
          ═══════════════════════════════════════════════════════ */}
      {activeFilters.length > 0 && (
        <motion.div
          className="explorer-active-filters"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
        >
          {activeFilters.map(f => (
            <motion.button
              key={f.key}
              className="explorer-filter-chip"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              onClick={() => removeFilter(f.key)}
            >
              {f.label}
              <X size={11} />
            </motion.button>
          ))}
          <button className="explorer-filter-chip clear" onClick={clearFilters}>
            <X size={12} /> Clear All
          </button>
        </motion.div>
      )}

      {/* ═══════════════════════════════════════════════════════
          FILTERS PANEL
          ═══════════════════════════════════════════════════════ */}
      <div className="explorer-filters-bar">
        <button className="explorer-filters-toggle" onClick={() => setFiltersExpanded(!filtersExpanded)}>
          <SlidersHorizontal size={14} />
          <span>Filters</span>
          {activeFilterCount > 0 && <span className="explorer-filter-count">{activeFilterCount}</span>}
          {filtersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {/* Quick sort — always visible */}
        <div className="explorer-quick-sort">
          <ArrowUpDown size={12} />
          <select
            className="explorer-sort-select"
            value={sort}
            onChange={e => { setSort(e.target.value); setTimeout(() => searchGyms(1), 0); }}
          >
            <option value="qualityScore">Quality Score</option>
            <option value="rating">Rating</option>
            <option value="totalReviews">Reviews</option>
            <option value="sentimentScore">Sentiment</option>
            <option value="createdAt">Newest</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      <AnimatePresence>
        {filtersExpanded && (
          <motion.div
            className="explorer-filters-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="explorer-filters-grid">
              <FilterGroup label="City / Area" icon={<MapPin size={12} />}>
                <select
                  className="input explorer-filter-input"
                  value={city}
                  onChange={e => { setCity(e.target.value); setTimeout(() => searchGyms(1), 0); }}
                >
                  <option value="">All Areas</option>
                  {cities.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
                </select>
              </FilterGroup>

              <FilterGroup label="Category" icon={<Tag size={12} />}>
                <select
                  className="input explorer-filter-input"
                  value={category}
                  onChange={e => { setCategory(e.target.value); setTimeout(() => searchGyms(1), 0); }}
                >
                  <option value="">All Categories</option>
                  {categories.map(c => <option key={c._id} value={c._id}>{formatCategory(c._id)} ({c.count})</option>)}
                </select>
              </FilterGroup>

              <FilterGroup label="Chain" icon={<Building2 size={12} />}>
                <select
                  className="input explorer-filter-input"
                  value={chain}
                  onChange={e => { setChain(e.target.value); setTimeout(() => searchGyms(1), 0); }}
                >
                  <option value="">All Chains</option>
                  {chainsCache.map(c => <option key={c.slug} value={c.slug}>{c.name} ({c.totalLocations || 0})</option>)}
                </select>
              </FilterGroup>

              <FilterGroup label="Min Rating" icon={<Star size={12} />}>
                <div className="explorer-rating-group">
                  {['', '3', '3.5', '4', '4.5'].map(r => (
                    <button
                      key={r}
                      className={`explorer-rating-btn ${rating === r ? 'active' : ''}`}
                      onClick={() => { setRating(r); setTimeout(() => searchGyms(1), 0); }}
                    >
                      {r ? `${r}+` : 'Any'}
                    </button>
                  ))}
                </div>
              </FilterGroup>

              <FilterGroup label="Min Reviews" icon={<MessageCircle size={12} />}>
                <input
                  className="input explorer-filter-input"
                  type="number" placeholder="0" min="0"
                  value={minReviews}
                  onChange={e => setMinReviews(e.target.value)}
                  onBlur={() => searchGyms(1)}
                  onKeyDown={e => e.key === 'Enter' && searchGyms(1)}
                />
              </FilterGroup>

              <FilterGroup label="Chain Only" icon={<Building2 size={12} />}>
                <div className="explorer-toggle-wrap">
                  <div
                    className={`explorer-toggle ${chainOnly ? 'active' : ''}`}
                    onClick={() => { setChainOnly(!chainOnly); setTimeout(() => searchGyms(1), 0); }}
                  >
                    <div className="explorer-toggle-knob" />
                  </div>
                  <span className="explorer-toggle-label">{chainOnly ? 'Yes' : 'No'}</span>
                </div>
              </FilterGroup>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════════════════════════════════════════════════════
          RESULTS TABLE
          ═══════════════════════════════════════════════════════ */}
      <div className="explorer-results-card">
        <div className="explorer-results-body">
          {loading ? (
            <Skeleton count={8} height={56} style={{ margin: '6px 14px' }} />
          ) : gyms.length > 0 ? (
            gyms.map((g, i) => (
              <motion.div
                key={g._id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: i * 0.02 }}
              >
                <GymRow gym={g} onClick={setSelectedGym} searchTerm={search} />
              </motion.div>
            ))
          ) : (
            <div className="explorer-empty">
              <div className="explorer-empty-icon">
                <Search size={40} />
              </div>
              <div className="explorer-empty-title">No gyms match your search</div>
              <div className="explorer-empty-desc">Try adjusting your filters or search terms</div>
              {(search || activeFilterCount > 0) && (
                <button className="btn primary" onClick={clearFilters} style={{ marginTop: 16 }}>
                  <X size={14} /> Clear All Filters
                </button>
              )}
            </div>
          )}
        </div>
        <Pagination current={page} total={pages} onPage={p => searchGyms(p)} />
      </div>

      {selectedGym && <GymDrawer gymId={selectedGym} onClose={() => setSelectedGym(null)} />}
    </motion.div>
  );
}

function FilterGroup({ label, icon, children }) {
  return (
    <div className="explorer-filter-group">
      <span className="explorer-filter-label">{icon} {label}</span>
      {children}
    </div>
  );
}
