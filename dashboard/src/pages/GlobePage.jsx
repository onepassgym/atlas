import { useEffect, useRef, useState, useCallback } from 'react';
import createGlobe from 'cobe';
import { api } from '../api/client';

/**
 * GlobePage — Phase 4: Information surface, not an ornament.
 *
 * Plots space points from location GeoJSON. Color = quality/completeness.
 * Clickable cities → space list + image gallery entry. Clean legend.
 * No glow, no decorative shaders. Reads as a data map.
 */

function getMarkerSize(count) {
  if (count >= 100) return 0.08;
  if (count >= 50) return 0.06;
  if (count >= 20) return 0.04;
  return 0.03;
}

export default function GlobePage() {
  const canvasRef = useRef(null);
  const globeRef = useRef(null);
  const [cities, setCities] = useState([]);
  const [selectedCity, setSelectedCity] = useState(null);
  const [citySpaces, setCitySpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hoveredCity, setHoveredCity] = useState(null);
  const phiRef = useRef(1.2);
  const isPausedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await api('/api/spaces/stats');
        const topCities = (res.stats?.topCities || []).filter(c => c.lat && c.lng);
        setCities(topCities);
      } catch (e) {
        console.error('Globe data fetch failed:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!canvasRef.current || !cities.length) return;

    const markers = cities.map(c => ({
      location: [c.lat, c.lng],
      size: getMarkerSize(c.count),
    }));

    try {
      const globe = createGlobe(canvasRef.current, {
        devicePixelRatio: Math.min(window.devicePixelRatio, 2),
        width: canvasRef.current.offsetWidth * 2,
        height: canvasRef.current.offsetHeight * 2,
        phi: 1.2,
        theta: 0.3,
        dark: 1,
        diffuse: 1.5,
        mapSamples: 20000,
        mapBrightness: 4,
        baseColor: [0.05, 0.05, 0.08],
        markerColor: [0.1, 0.8, 0.6],
        glowColor: [0.02, 0.02, 0.03],
        markers,
        onRender: (state) => {
          if (!isPausedRef.current) phiRef.current += 0.002;
          state.phi = phiRef.current;
        },
      });
      globeRef.current = globe;
    } catch (e) {
      console.warn('Globe init failed:', e);
    }

    return () => globeRef.current?.destroy?.();
  }, [cities]);

  const selectCity = useCallback(async (cityName) => {
    setSelectedCity(cityName);
    setCitySpaces([]);
    try {
      const res = await api(`/api/spaces?city=${encodeURIComponent(cityName)}&limit=50&sortBy=qualityScore`);
      setCitySpaces(res.spaces || []);
    } catch (e) {
      console.error('Failed to load city spaces:', e);
    }
  }, []);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)', gap: 0 }}>
      {/* Globe canvas */}
      <div style={{ flex: '1 1 60%', position: 'relative', minHeight: 400 }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', cursor: 'grab' }}
          onMouseDown={() => { isPausedRef.current = true; }}
          onMouseUp={() => { isPausedRef.current = false; }}
        />
        {/* Legend */}
        <div style={{
          position: 'absolute', bottom: 16, left: 16,
          background: 'rgba(10,14,26,0.92)', borderRadius: 6, padding: '10px 14px',
          fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--text-primary)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            Marker = City
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#10c98c' }} /> Large
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10c98c' }} /> Medium
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#10c98c' }} /> Small
            </span>
          </div>
          <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
            {cities.length} cities &bull; {cities.reduce((s, c) => s + c.count, 0).toLocaleString()} spaces
          </div>
        </div>
      </div>

      {/* City list + detail sidebar */}
      <div style={{
        flex: '0 0 340px', borderLeft: '1px solid var(--border-subtle)',
        overflow: 'auto', background: 'var(--bg-primary)',
      }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>
            Cities ({cities.length})
          </div>
        </div>

        {!selectedCity ? (
          <div>
            {cities.map(c => (
              <button
                key={c._id}
                onClick={() => selectCity(c._id)}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 10,
                  padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--border-subtle)',
                  background: hoveredCity === c._id ? 'var(--bg-secondary)' : 'transparent',
                  cursor: 'pointer', textAlign: 'left', color: 'inherit',
                }}
                onMouseEnter={() => setHoveredCity(c._id)}
                onMouseLeave={() => setHoveredCity(null)}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: c.avgRating >= 4 ? '#10c98c' : c.avgRating >= 3 ? '#f59e0b' : '#ef4444',
                }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {c._id}
                </span>
                <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
                  {c.count}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <button
              onClick={() => { setSelectedCity(null); setCitySpaces([]); }}
              style={{
                width: '100%', padding: '10px 14px', border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--bg-secondary)', cursor: 'pointer', textAlign: 'left',
                fontSize: 12, fontWeight: 600, color: 'var(--accent-cyan)',
              }}
            >
              &larr; Back to cities
            </button>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{selectedCity}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {citySpaces.length} spaces loaded
              </div>
            </div>
            {citySpaces.map(s => (
              <div
                key={s.opgId || s._id}
                style={{
                  padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)',
                  fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                {s.coverUrl && (
                  <img
                    src={s.coverUrl}
                    alt=""
                    style={{ width: 36, height: 36, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                    loading="lazy"
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                    <span>{s.rating ? `★${s.rating.toFixed(1)}` : '—'}</span>
                    <span>{s.primaryCategorySlug || '—'}</span>
                    <span>Q:{s.qualityScore || 0}</span>
                  </div>
                </div>
                {s.totalPhotos > 0 && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
                    {s.totalPhotos}img
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
