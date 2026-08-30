import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Star, MapPin, Phone, Globe, Map, ExternalLink, Zap,
  MessageSquare, Camera, Clock, Dumbbell, RefreshCw, Sparkles,
  CheckCircle, XCircle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

const SECTIONS = [
  { key: 'reviews',   label: 'Reviews',       icon: MessageSquare, color: '#f59e0b' },
  { key: 'photos',    label: 'Photos',        icon: Camera,        color: '#8b5cf6' },
  { key: 'contact',   label: 'Contact & Info', icon: Phone,        color: '#3b82f6' },
  { key: 'hours',     label: 'Hours',         icon: Clock,         color: '#10b981' },
  { key: 'amenities', label: 'Amenities',     icon: Dumbbell,      color: '#ec4899' },
];

export default function SpaceDrawer({ spaceId, onClose }) {
  const { toast } = useApp();
  const [space, setSpace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [selectedSections, setSelectedSections] = useState([]);
  const [enrichLogs, setEnrichLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Toggle a section chip
  const toggleSection = useCallback((key) => {
    setSelectedSections(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }, []);

  // Full enrich (all sections)
  const handleFullEnrich = async () => {
    if (!space?._id) return;
    setEnriching(true);
    try {
      const res = await api.post('/api/enrichment/priority', { spaceId: space.opgId, sections: ['all'] });
      if (res?.success) {
        toast(`⚡ ${space.name} → full enrichment queued`, 'info');
        loadEnrichLogs();
      } else {
        toast(res?.error || 'Failed to enrich', 'error');
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setEnriching(false);
    }
  };

  // Deep enrich (150 reviews + 80 photos)
  const handleDeepEnrich = async () => {
    if (!space?._id) return;
    setEnriching(true);
    try {
      const res = await api.post('/api/enrichment/priority', { spaceId: space.opgId, sections: ['deep'] });
      if (res?.success) {
        toast(`🔬 ${space.name} → deep enrichment queued (150 reviews + 80 photos)`, 'info');
        loadEnrichLogs();
      } else {
        toast(res?.error || 'Failed to enrich', 'error');
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setEnriching(false);
    }
  };

  // Selective enrich (chosen sections only)
  const handleSelectiveEnrich = async () => {
    if (!space?._id || selectedSections.length === 0) return;
    setEnriching(true);
    try {
      const res = await api.post('/api/enrichment/priority', { spaceId: space.opgId, sections: selectedSections });
      if (res?.success) {
        toast(`⚡ ${space.name} → enriching: ${selectedSections.join(', ')}`, 'info');
        setSelectedSections([]);
        loadEnrichLogs();
      } else {
        toast(res?.error || 'Failed to enrich', 'error');
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setEnriching(false);
    }
  };

  // Load enrichment history for this space
  const loadEnrichLogs = useCallback(async () => {
    if (!spaceId) return;
    setLogsLoading(true);
    try {
      const res = await api.get(`/api/enrichment/logs/${spaceId}?limit=5`);
      if (res?.success) setEnrichLogs(res.logs || []);
    } catch (_) {}
    finally { setLogsLoading(false); }
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    setLoading(true);
    api.get(`/api/spaces/${spaceId}`)
      .then(res => { if (res?.success) setSpace(res.space); })
      .catch(() => {})
      .finally(() => setLoading(false));
    loadEnrichLogs();
  }, [spaceId, loadEnrichLogs]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  if (!spaceId) return null;

  const enrichMeta = space?.enrichmentMeta;
  const hasGmapsUrl = !!space?.googleMapsUrl;

  return (
    <AnimatePresence>
      <motion.div
        className="drawer-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="drawer"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      >
        <div className="drawer-header">
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>Space Details</h3>
          <button onClick={onClose} style={{ fontSize: 20, cursor: 'pointer', color: 'var(--text-muted)', background: 'none', border: 'none', padding: '4px 8px' }}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          {loading ? (
            <div className="empty-state"><div className="empty-state-icon">⏳</div><div>Loading…</div></div>
          ) : !space ? (
            <div className="empty-state">Failed to load space details</div>
          ) : (
            <>
              {(space.photos?.[0]?.url || space.coverPhoto) && (
                <img
                  src={space.photos?.[0]?.url || space.coverPhoto}
                  alt={space.name}
                  style={{ width: '100%', height: 180, objectFit: 'cover', borderRadius: 'var(--radius-sm)', marginBottom: 16 }}
                  onError={e => e.target.style.display = 'none'}
                />
              )}
              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{space.name}</h2>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--warning)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Star size={14} /> {space.rating?.toFixed(1) || '—'}
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({(space.totalReviews || 0).toLocaleString()} reviews)</span>
                </span>
                <span style={{ color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 4 }}>🎯 Quality: {space.qualityScore || 0}</span>
                <span style={{ color: (space.sentimentScore || 0) > 0 ? 'var(--success)' : 'var(--danger)' }}>
                  😊 Sentiment: {space.sentimentScore?.toFixed(2) || '—'}
                </span>
              </div>
              {space.chainName && (
                <div style={{ marginBottom: 16 }}>
                  <span style={{ padding: '4px 12px', background: 'rgba(139,92,246,0.15)', color: 'var(--purple)', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>🔗 {space.chainName}</span>
                </div>
              )}

              {/* ── Enrichment Panel ──────────────────────────────────────────── */}
              <div className="enrich-panel" id="enrichment-panel">
                <div className="enrich-panel-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Sparkles size={15} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.2 }}>Enrichment Engine</span>
                  </div>
                  {enrichMeta && enrichMeta.status !== 'never' && (
                    <EnrichStatusBadge status={enrichMeta.status} lastSuccess={enrichMeta.lastSuccess} />
                  )}
                </div>

                {/* Quick Actions */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  <button
                    className="btn accent enrich-btn"
                    onClick={handleFullEnrich}
                    disabled={enriching || !hasGmapsUrl}
                    title={hasGmapsUrl ? 'Full re-scrape: core + reviews + photos + amenities' : 'No Google Maps URL'}
                    id="btn-full-enrich"
                  >
                    <Zap size={13} />
                    {enriching ? 'Queuing…' : 'Full Enrich'}
                  </button>
                  <button
                    className="btn enrich-btn"
                    onClick={handleDeepEnrich}
                    disabled={enriching || !hasGmapsUrl}
                    title="Deep mode: 150 reviews + 80 photos"
                    style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple)', border: '1px solid rgba(139,92,246,0.25)' }}
                    id="btn-deep-enrich"
                  >
                    <Sparkles size={13} />
                    Deep Enrich
                  </button>
                </div>

                {/* Section Chips */}
                <div style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                    Or pick specific sections
                  </span>
                  <div className="enrich-chips">
                    {SECTIONS.map(s => {
                      const Icon = s.icon;
                      const active = selectedSections.includes(s.key);
                      return (
                        <button
                          key={s.key}
                          className={`enrich-chip ${active ? 'active' : ''}`}
                          onClick={() => toggleSection(s.key)}
                          disabled={!hasGmapsUrl}
                          style={{
                            '--chip-color': s.color,
                            borderColor: active ? s.color : undefined,
                            background: active ? `${s.color}18` : undefined,
                            color: active ? s.color : undefined,
                          }}
                          id={`chip-${s.key}`}
                        >
                          <Icon size={12} />
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Enrich Selected Button */}
                <AnimatePresence>
                  {selectedSections.length > 0 && (
                    <motion.button
                      className="btn accent enrich-btn"
                      onClick={handleSelectiveEnrich}
                      disabled={enriching}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
                      id="btn-selective-enrich"
                    >
                      <RefreshCw size={13} />
                      Enrich {selectedSections.length} section{selectedSections.length > 1 ? 's' : ''}
                    </motion.button>
                  )}
                </AnimatePresence>

                {/* Last Updated */}
                {space.updatedAt && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    Last updated: {new Date(space.updatedAt).toLocaleDateString()} at {new Date(space.updatedAt).toLocaleTimeString()}
                  </span>
                )}
              </div>

              {/* ── Enrichment History ────────────────────────────────────────── */}
              <div className="drawer-section" style={{ marginTop: 8 }}>
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
                    cursor: 'pointer', color: 'var(--text-secondary)', fontWeight: 700, fontSize: 12,
                    padding: 0, width: '100%', justifyContent: 'space-between',
                  }}
                  id="btn-toggle-history"
                >
                  <span>Enrichment History ({enrichLogs.length})</span>
                  {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <AnimatePresence>
                  {showHistory && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      style={{ overflow: 'hidden', marginTop: 8 }}
                    >
                      {logsLoading ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>
                      ) : enrichLogs.length === 0 ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No enrichment history yet</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {enrichLogs.map((log, i) => (
                            <div key={i} className="enrich-log-row">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {log.status === 'success' ? (
                                  <CheckCircle size={13} style={{ color: 'var(--success)', flexShrink: 0 }} />
                                ) : (
                                  <XCircle size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                                )}
                                <span style={{ fontSize: 11, fontWeight: 600 }}>
                                  {log.status === 'success' ? 'Success' : 'Failed'}
                                </span>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                  {new Date(log.startedAt).toLocaleDateString()} {new Date(log.startedAt).toLocaleTimeString()}
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                                {log.durationMs && <span>⏱ {(log.durationMs / 1000).toFixed(1)}s</span>}
                                {log.reviewsAdded > 0 && <span>📝 +{log.reviewsAdded} reviews</span>}
                                {log.photosAdded > 0 && <span>📸 +{log.photosAdded} photos</span>}
                                {log.fieldsUpdated?.length > 0 && <span>🔄 {log.fieldsUpdated.length} fields</span>}
                                {log.error && <span style={{ color: 'var(--danger)' }}>❌ {log.error.slice(0, 60)}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ── Contact & Location ────────────────────────────────────────── */}
              <div className="drawer-section">
                <div className="drawer-section-title">Contact & Location</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {space.address && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><MapPin size={13} /> {space.address}</span>}
                  {(space.contact?.phone || space.phone) && <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Phone size={13} /> {space.contact?.phone || space.phone}</span>}
                  {(space.contact?.website || space.website) && (
                    <a href={space.contact?.website || space.website} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Globe size={13} /> {(space.contact?.website || space.website).replace(/https?:\/\//, '').slice(0, 40)}
                    </a>
                  )}
                  {space.googleMapsUrl && (
                    <a href={space.googleMapsUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Map size={13} /> View on Google Maps <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              </div>

              {/* ── Opening Hours ─────────────────────────────────────────────── */}
              <div className="drawer-section">
                <div className="drawer-section-title">Opening Hours</div>
                {(space.openingHours || []).length > 0 ? space.openingHours.map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                    <span>{h.day || h}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{h.hours || ''}</span>
                  </div>
                )) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Not available</span>}
              </div>

              {/* ── Amenities ────────────────────────────────────────────────── */}
              {(space.amenityIds || []).length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title">Amenities</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    {space.amenityIds.map((a, i) => (
                      <span key={i} style={{ display: 'inline-block', padding: '3px 10px', background: 'rgba(59,130,246,0.1)', borderRadius: 20, fontSize: 11, margin: 2, color: 'var(--accent)' }}>
                        {a.icon || '•'} {a.label || a.slug}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Reviews ──────────────────────────────────────────────────── */}
              <div className="drawer-section">
                <div className="drawer-section-title">Reviews</div>
                {(space.reviews || []).length > 0 ? space.reviews.slice(0, 5).map((r, i) => (
                  <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(75,85,99,0.1)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 12 }}>{r.authorName || 'Anonymous'}</span>
                      <span style={{ color: 'var(--warning)', fontSize: 12 }}>{'⭐'.repeat(Math.min(r.rating || 0, 5))}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      {(r.text || r.snippet || '').slice(0, 200)}
                    </div>
                  </div>
                )) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No reviews available</span>}
              </div>

              {/* ── Photo Gallery (AI Enriched) ──────────────────────────────────────────────── */}
              {space.photos && space.photos.length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title">
                    Media Gallery <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>({space.photos.length})</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 8 }}>
                    {space.photos.map((photo, i) => (
                      <div key={i} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', height: 120, background: '#1f2937' }}>
                        <img 
                          src={photo.thumbnailUrl || photo.url} 
                          alt="Space" 
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                        {/* Overlay for AI metadata */}
                        <div style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0, 
                          background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)',
                          padding: '20px 8px 6px', display: 'flex', flexDirection: 'column', gap: 4
                        }}>
                          {photo.appealScore > 0 && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)' }}>
                              ⚡ {photo.appealScore}/100
                            </span>
                          )}
                          {(photo.tags && photo.tags.length > 0) && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                              {photo.tags.slice(0, 2).map((tag, ti) => (
                                <span key={ti} style={{ fontSize: 8, padding: '2px 4px', background: 'rgba(255,255,255,0.2)', borderRadius: 4, color: '#fff' }}>
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>ID: {space.opgId}</div>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────────── */

function EnrichStatusBadge({ status, lastSuccess }) {
  const config = {
    success: { bg: 'rgba(16,185,129,0.12)', color: '#10b981', label: '✓ Enriched' },
    failed:  { bg: 'rgba(239,68,68,0.12)',   color: '#ef4444', label: '✗ Failed' },
    never:   { bg: 'rgba(107,114,128,0.12)', color: '#6b7280', label: '— Never' },
  };
  const c = config[status] || config.never;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700,
        background: c.bg, color: c.color, letterSpacing: 0.3,
      }}>
        {c.label}
      </span>
      {lastSuccess && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {new Date(lastSuccess).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}
