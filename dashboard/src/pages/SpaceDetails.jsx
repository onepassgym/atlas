import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Star, MapPin, Globe, Phone, Dumbbell, Map, Clock, Zap, MessageSquare, Camera } from 'lucide-react';
import { api, getProxyUrl } from '../api/client';
import { useApp } from '../context/AppContext';
import Skeleton from '../components/Skeleton';
import RatingStars from '../components/RatingStars';

export default function SpaceDetails() {
  const { id } = useParams();
  const { toast } = useApp();
  const [gym, setGym] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api.get(`/api/spaces/${id}`)
      .then(res => {
        if (res?.success) setGym(res.gym);
        else toast('Failed to load space details', 'error');
      })
      .catch(e => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [id, toast]);

  if (loading) {
    return (
      <div className="container" style={{ padding: '24px 0' }}>
        <Skeleton height={200} style={{ marginBottom: 16 }} />
        <Skeleton height={40} count={3} style={{ marginBottom: 8 }} />
      </div>
    );
  }

  if (!gym) {
    return (
      <div className="container" style={{ padding: '40px 0', textAlign: 'center' }}>
        <div className="empty-state">
          <div className="empty-state-icon">❌</div>
          <h2>Space Not Found</h2>
          <Link to="/" className="btn primary" style={{ display: 'inline-block', marginTop: 16 }}>Go Back</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Link to="/" className="btn sm">
          <ArrowLeft size={14} /> Back
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>{gym.name}</h1>
        {gym.chainName && (
          <span className="badge" style={{ background: 'var(--purple)', color: '#fff' }}>
            🔗 {gym.chainName}
          </span>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 300px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Header & Main Image */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {(gym.photos?.[0]?.proxyUrl || gym.photos?.[0]?.url || gym.coverPhoto) ? (
              <img 
                src={getProxyUrl(gym.photos?.[0]?.proxyUrl || gym.photos?.[0]?.url || gym.coverPhoto?.publicUrl || gym.coverPhoto)} 
                alt={gym.name} 
                style={{ width: '100%', height: 350, objectFit: 'cover' }} 
                onError={(e) => {
                  e.target.style.display = 'none';
                  e.target.nextElementSibling.style.display = 'flex';
                }}
              />
            ) : null}
            <div style={{ width: '100%', height: 350, background: 'var(--bg-surface)', display: (gym.photos?.[0]?.proxyUrl || gym.photos?.[0]?.url || gym.coverPhoto) ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
              <MapPin size={48} />
            </div>
            
            <div style={{ padding: 24 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RatingStars rating={gym.rating} />
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>({(gym.totalReviews || 0).toLocaleString()} reviews)</span>
                </div>
                {gym.qualityScore > 0 && (
                  <span style={{ color: 'var(--success)', fontSize: 14, fontWeight: 600 }}>🎯 Quality: {gym.qualityScore}</span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--text-secondary)' }}>
                {gym.areaName && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <MapPin size={16} style={{ marginTop: 2, color: 'var(--text-muted)' }} />
                    <span>{gym.address || gym.areaName}</span>
                  </div>
                )}
                {gym.contactPhone && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Phone size={16} style={{ color: 'var(--text-muted)' }} />
                    <a href={`tel:${gym.contactPhone}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{gym.contactPhone}</a>
                  </div>
                )}
                {gym.websiteUrl && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Globe size={16} style={{ color: 'var(--text-muted)' }} />
                    <a href={gym.websiteUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{new URL(gym.websiteUrl).hostname}</a>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Details Sections */}
          <div className="card">
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dumbbell size={18} color="var(--accent)" /> Overview & Amenities
            </h3>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 24 }}>
              {gym.description || 'No description available for this space.'}
            </p>
            {gym.amenityIds?.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {gym.amenityIds.map(am => (
                  <span key={am._id} style={{ padding: '6px 12px', background: 'var(--bg-surface)', borderRadius: 20, fontSize: 13, border: '1px solid var(--border)' }}>
                    {am.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Action Panel */}
          <div className="card">
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Zap size={18} color="#f59e0b" /> Actions
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}>
                Fetch Latest Reviews
              </button>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }}>
                Full Enrichment
              </button>
              {gym.googleMapsUrl && (
                <a href={gym.googleMapsUrl} target="_blank" rel="noreferrer" className="btn" style={{ width: '100%', justifyContent: 'center', display: 'flex' }}>
                  <Map size={14} /> Open in Google Maps
                </a>
              )}
            </div>
          </div>

          {/* Enrichment Metadata */}
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Enrichment Info
            </h3>
            <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--text-secondary)' }}>
              <div>Status: <strong style={{ color: 'var(--text-primary)' }}>{gym.enrichmentMeta?.status || 'never'}</strong></div>
              <div>Last Attempt: <strong style={{ color: 'var(--text-primary)' }}>{gym.enrichmentMeta?.lastAttempt ? new Date(gym.enrichmentMeta.lastAttempt).toLocaleDateString() : '—'}</strong></div>
              <div>Last Success: <strong style={{ color: 'var(--text-primary)' }}>{gym.enrichmentMeta?.lastSuccess ? new Date(gym.enrichmentMeta.lastSuccess).toLocaleDateString() : '—'}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
