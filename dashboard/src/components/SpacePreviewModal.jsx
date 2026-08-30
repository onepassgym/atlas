import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Star, MapPin, Sparkles, ExternalLink } from 'lucide-react';
import { api, getProxyUrl } from '../api/client';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import RatingStars from './RatingStars';

export default function SpacePreviewModal({ spaceId, onClose }) {
  const { toast } = useApp();
  const [space, setSpace] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!spaceId) return;
    setLoading(true);
    api.get(`/api/spaces/${spaceId}`)
      .then(res => {
        if (res?.success) setSpace(res.space);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [spaceId]);

  if (!spaceId) return null;

  return (
    <Modal open={true} onClose={onClose} title="Space Preview">
      {loading ? (
        <div className="empty-state"><div className="empty-state-icon">⏳</div><div>Loading…</div></div>
      ) : !space ? (
        <div className="empty-state">Failed to load details</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(space.photos?.[0]?.proxyUrl || space.photos?.[0]?.url || space.coverPhoto?.publicUrl || space.coverPhoto) && (
            <img
              src={getProxyUrl(space.photos?.[0]?.proxyUrl || space.photos?.[0]?.url || space.coverPhoto?.publicUrl || space.coverPhoto)}
              alt={space.name}
              style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 8 }}
              onError={e => e.target.style.display = 'none'}
            />
          )}
          
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px 0' }}>{space.name}</h2>
            {space.chainName && (
              <span className="badge" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple)', marginBottom: 8, display: 'inline-block' }}>
                🔗 {space.chainName}
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
              <MapPin size={14} /> {space.areaName || space.address || 'Unknown Location'}
            </div>
            
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--warning)', fontWeight: 600 }}>
                <RatingStars rating={space.rating} />
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({space.totalReviews || 0} reviews)</span>
            </div>
          </div>

          <div style={{ padding: 12, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ fontWeight: 600, fontSize: 12 }}>Enrichment Status: <span style={{ color: 'var(--text-primary)' }}>{space.enrichmentMeta?.status || 'never'}</span></span>
            </div>
            {space.qualityScore > 0 && <div style={{ fontSize: 12, color: 'var(--success)' }}>Quality Score: {space.qualityScore}</div>}
          </div>

          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button className="btn" onClick={onClose}>Close</button>
            <Link to={`/spaces/${space.opgId}`} className="btn primary" onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              View Full Details <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      )}
    </Modal>
  );
}
