import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Star, MapPin, Sparkles, ExternalLink } from 'lucide-react';
import { api, getProxyUrl } from '../api/client';
import { useApp } from '../context/AppContext';
import Modal from './Modal';
import RatingStars from './RatingStars';

export default function GymPreviewModal({ gymId, onClose }) {
  const { toast } = useApp();
  const [gym, setGym] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!gymId) return;
    setLoading(true);
    api.get(`/api/spaces/${gymId}`)
      .then(res => {
        if (res?.success) setGym(res.gym);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [gymId]);

  if (!gymId) return null;

  return (
    <Modal open={true} onClose={onClose} title="Space Preview">
      {loading ? (
        <div className="empty-state"><div className="empty-state-icon">⏳</div><div>Loading…</div></div>
      ) : !gym ? (
        <div className="empty-state">Failed to load details</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(gym.photos?.[0]?.proxyUrl || gym.photos?.[0]?.url || gym.coverPhoto?.publicUrl || gym.coverPhoto) && (
            <img
              src={getProxyUrl(gym.photos?.[0]?.proxyUrl || gym.photos?.[0]?.url || gym.coverPhoto?.publicUrl || gym.coverPhoto)}
              alt={gym.name}
              style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 8 }}
              onError={e => e.target.style.display = 'none'}
            />
          )}
          
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px 0' }}>{gym.name}</h2>
            {gym.chainName && (
              <span className="badge" style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--purple)', marginBottom: 8, display: 'inline-block' }}>
                🔗 {gym.chainName}
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
              <MapPin size={14} /> {gym.areaName || gym.address || 'Unknown Location'}
            </div>
            
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--warning)', fontWeight: 600 }}>
                <RatingStars rating={gym.rating} />
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({gym.totalReviews || 0} reviews)</span>
            </div>
          </div>

          <div style={{ padding: 12, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ fontWeight: 600, fontSize: 12 }}>Enrichment Status: <span style={{ color: 'var(--text-primary)' }}>{gym.enrichmentMeta?.status || 'never'}</span></span>
            </div>
            {gym.qualityScore > 0 && <div style={{ fontSize: 12, color: 'var(--success)' }}>Quality Score: {gym.qualityScore}</div>}
          </div>

          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button className="btn" onClick={onClose}>Close</button>
            <Link to={`/spaces/${gym._id}`} className="btn primary" onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              View Full Details <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      )}
    </Modal>
  );
}
