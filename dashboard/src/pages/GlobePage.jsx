import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import createGlobe from 'cobe';
import { MapPin, Dumbbell, Building2, Globe2, ArrowRight, Maximize2, Minimize2, Search, Play, Pause, Map as MapIcon, Layers, Target, Activity } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';

// ── Initial Marker (just one to avoid empty state flash) ───────────────────────
const BASE_MARKERS = [
  { name: 'Mumbai', coords: [19.076, 72.878], size: 0.10 },
];

export default function GlobePage() {
  const { theme, toast, events } = useApp();
  const canvasRef = useRef(null);
  const pointerDown = useRef(false);
  const pointerDeltaRef = useRef({ x: 0, y: 0 });
  const phiRef = useRef(0);
  const thetaRef = useRef(0.3);
  const widthRef = useRef(0);
  const focusRef = useRef(null); // stores [lat, lng] to focus on
  const isPausedRef = useRef(false);

  // Auto-Tour references
  const isTouringRef = useRef(false);
  const tourTargetNameRef = useRef(null);

  const [isPaused, setIsPaused] = useState(false);
  const [isTouring, setIsTouring] = useState(false);
  const [zoom, setZoom] = useState(1);

  const [stats, setStats] = useState(null);
  const [hoveredCity, setHoveredCity] = useState(null);
  const [cityStats, setCityStats] = useState({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const globeContainerRef = useRef(null);

  // Dynamic Markers State
  const [dynamicMarkers, setDynamicMarkers] = useState(BASE_MARKERS);
  const [newCityName, setNewCityName] = useState('');
  const [isGeocoding, setIsGeocoding] = useState(false);

  // Helper: Geocode a city using Nominatim
  const geocodeCity = async (cityName) => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityName)}&format=json&limit=1`);
      const data = await res.json();
      if (data && data.length > 0) {
        return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
      }
    } catch (e) {
      console.error('Geocoding error:', e);
    }
    return null;
  };

  // Fetch overview stats and populate markers from accurate DB coordinates
  useEffect(() => {
    api.get('/api/spaces/stats').then(res => {
      if (res?.success && res.stats?.topCities) {
        setStats(res.stats);
        
        const lookup = {};
        const newMarkers = [];
        
        // Find max count to normalize sizes
        let maxCount = 1;
        res.stats.topCities.forEach(c => { if (c.count > maxCount) maxCount = c.count; });

        res.stats.topCities.forEach(c => {
          if (!c._id) return;
          lookup[c._id.toLowerCase()] = c.count;
          
          if (c.lat && c.lng) {
            // Size normalizes between 0.04 and 0.12 based on log scale
            const size = 0.04 + (Math.log(c.count + 1) / Math.log(maxCount + 1)) * 0.08;
            newMarkers.push({
              name: c._id,
              coords: [c.lat, c.lng],
              size,
              count: c.count
            });
          }
        });
        
        setCityStats(lookup);
        if (newMarkers.length > 0) {
          setDynamicMarkers(newMarkers);
          // Make the initial globe pointer/focus dynamic based on the top city in DB
          if (!focusRef.current && newMarkers[0]?.coords) {
            focusRef.current = newMarkers[0].coords;
          }
        }
      }
    }).catch(() => {});
  }, []); // Only run once on mount

  // Globe init with drag support & focus tracking
  useEffect(() => {
    if (!canvasRef.current) return;
    const isDark = theme === 'dark';

    let currentPhi = phiRef.current;
    let currentTheta = thetaRef.current;
    let globe;

    const onResize = () => {
      if (canvasRef.current) {
        widthRef.current = canvasRef.current.offsetWidth;
      }
    };
    window.addEventListener('resize', onResize);
    onResize();

    try {
      globe = createGlobe(canvasRef.current, {
        devicePixelRatio: 2,
        width: widthRef.current * 2 || 1200,
        height: widthRef.current * 2 || 1200,
        phi: currentPhi,
        theta: currentTheta,
        dark: isDark ? 1 : 0,
        diffuse: isDark ? 3 : 2.2,
        mapSamples: 32000,
        mapBrightness: isDark ? 8 : 2,
        baseColor: isDark ? [0.05, 0.06, 0.12] : [0.97, 0.97, 1],
        markerColor: isDark ? [0.2, 0.7, 1] : [0.15, 0.4, 0.95],
        glowColor: isDark ? [0.04, 0.06, 0.15] : [0.82, 0.84, 0.98],
        markers: dynamicMarkers.map(c => ({
          location: c.coords,
          size: c.size,
        })),
        onRender: (state) => {
          // Manual drag mapping
          if (pointerDown.current) {
            currentPhi += pointerDeltaRef.current.x;
            currentTheta = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, currentTheta + pointerDeltaRef.current.y));
            pointerDeltaRef.current = { x: 0, y: 0 };
            focusRef.current = null; // Clear focus if user drags
          } 
          // Animate to focus city
          else if (focusRef.current) {
            const [lat, lng] = focusRef.current;
            // Accurate Cobe camera mapping for lat/lng centering
            const targetPhi = Math.PI - (lng * Math.PI) / 180;
            const targetTheta = (lat * Math.PI) / 180;
            
            // Normalize phi difference to take the shortest path
            let dPhi = targetPhi - currentPhi;
            while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
            while (dPhi < -Math.PI) dPhi += 2 * Math.PI;

            currentPhi += dPhi * 0.08;
            currentTheta += (targetTheta - currentTheta) * 0.08;

            if (Math.abs(dPhi) < 0.005 && Math.abs(targetTheta - currentTheta) < 0.005) {
               focusRef.current = null; // Reached target
            }
          } 
          // Auto rotate (if not paused and not touring to a target)
          else if (!isPausedRef.current && !isTouringRef.current) {
            currentPhi += 0.003;
          } else if (isTouringRef.current && !focusRef.current) {
            currentPhi += 0.001; // slow pan while sitting at target
          }

          // Pulse effect for queued cities or active tour target
          const time = Date.now() / 150;
          state.markers = dynamicMarkers.map(c => {
             let size = c.size;
             const isTourTarget = isTouringRef.current && c.name === tourTargetNameRef.current;
             if (c.isQueued || isTourTarget) {
               const pulse = (Math.sin(time * (isTourTarget ? 1.5 : 1)) + 1) / 2; // faster pulse for tour
               size += pulse * (isTourTarget ? 0.08 : 0.04);
             }
             return { location: c.coords, size };
          });

          state.phi = currentPhi;
          state.theta = currentTheta;
          state.width = widthRef.current * 2 || 1200;
          state.height = widthRef.current * 2 || 1200;

          phiRef.current = currentPhi;
          thetaRef.current = currentTheta;
        },
      });
    } catch (e) {
      console.warn('Globe init failed:', e);
    }

    return () => {
      globe?.destroy?.();
      window.removeEventListener('resize', onResize);
    };
  }, [theme, dynamicMarkers]); // Re-init if markers or theme change

  // Pointer drag handlers
  const handlePointerDown = useCallback((e) => {
    pointerDown.current = true;
    e.currentTarget.style.cursor = 'grabbing';
  }, []);

  const handlePointerUp = useCallback((e) => {
    pointerDown.current = false;
    e.currentTarget.style.cursor = 'grab';
  }, []);

  const handlePointerOut = useCallback(() => {
    pointerDown.current = false;
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (pointerDown.current) {
      pointerDeltaRef.current = {
        x: e.movementX / (150 * zoom),
        y: e.movementY / (150 * zoom),
      };
    }
  }, [zoom]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.4, Math.min(4, z - e.deltaY * 0.002)));
  }, []);

  // Attach native wheel event listener to prevent default scrolling while zooming
  useEffect(() => {
    const canvasContainer = globeContainerRef.current;
    if (canvasContainer) {
      canvasContainer.addEventListener('wheel', handleWheel, { passive: false });
      return () => canvasContainer.removeEventListener('wheel', handleWheel);
    }
  }, [handleWheel]);

  const togglePause = () => {
     setIsPaused(!isPaused);
     isPausedRef.current = !isPaused;
  };

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      globeContainerRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
    setIsFullscreen(!isFullscreen);
  };

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Submit New City to Crawl
  const handleCrawlCity = async (e) => {
    e.preventDefault();
    if (!newCityName.trim() || isGeocoding) return;
    
    const name = newCityName.trim();
    setNewCityName('');
    setIsGeocoding(true);
    toast(`Locating ${name}...`, 'info');

    try {
      // 1. Geocode
      const coords = await geocodeCity(name);
      if (coords) {
         setDynamicMarkers(prev => {
            const copy = prev.filter(m => m.name.toLowerCase() !== name.toLowerCase());
            return [...copy, { name, coords, size: 0.1, isQueued: true }];
         });
         focusRef.current = coords;
         toast(`Located ${name}. Queuing crawl...`, 'success');
      } else {
         toast(`Could not locate ${name} precisely on map.`, 'warning');
      }

      // 2. Schedule Crawl
      const res = await api.post('/api/crawl/city', { cityName: name });
      if (res.success) {
        toast(`Crawl job queued for ${name}`, 'success');
      } else {
        toast(`Failed to queue ${name}`, 'error');
      }
    } catch (err) {
      toast(`Error: ${err.message}`, 'error');
    } finally {
      setIsGeocoding(false);
    }
  };

  const handleCityClick = (city) => {
     focusRef.current = city.coords;
  };

  const totalSpaces = stats?.total || 0;
  const totalCities = stats?.topCities?.length || 0;
  const totalReviews = stats?.totalReviews || 0;

  // Render city list sorted by active vs inactive
  const sortedMarkers = useMemo(() => {
      return [...dynamicMarkers].sort((a, b) => {
         const countA = cityStats[a.name.toLowerCase()] || 0;
         const countB = cityStats[b.name.toLowerCase()] || 0;
         return countB - countA;
      });
  }, [dynamicMarkers, cityStats]);

  // Autonomous Tour Logic
  useEffect(() => {
    isTouringRef.current = isTouring;
    if (!isTouring || sortedMarkers.length === 0) {
      tourTargetNameRef.current = null;
      setHoveredCity(null);
      return;
    }

    let currentIndex = 0;
    const tourNext = () => {
      const city = sortedMarkers[currentIndex];
      if (city) {
        focusRef.current = city.coords;
        tourTargetNameRef.current = city.name;
        setHoveredCity(city.name);
      }
      currentIndex = (currentIndex + 1) % Math.min(sortedMarkers.length, 15); // Loop through top 15
    };

    tourNext(); // trigger first
    const interval = setInterval(tourNext, 5000); // jump every 5 seconds
    
    return () => clearInterval(interval);
  }, [isTouring, sortedMarkers]);

  const toggleTour = () => setIsTouring(!isTouring);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="globe-page-container"
    >
      {/* ── Background Globe Canvas ────── */}
      <div
        ref={globeContainerRef}
        className="globe-canvas-wrapper"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerOut={handlePointerOut}
        onPointerMove={handlePointerMove}
        style={{ background: isFullscreen ? 'var(--bg-primary)' : '' }}
      >
        <TelemetryOverlay isTouring={isTouring} isPaused={isPaused} />
        
        {/* Glow behind globe */}
        <div className="globe-ambient-glow" />
        
        <canvas
          ref={canvasRef}
          style={{
            width: '100%', maxWidth: 800, aspectRatio: '1',
            touchAction: 'none',
            transform: `scale(${zoom})`,
            transition: 'transform 0.1s ease-out',
            zIndex: 2, position: 'relative'
          }}
        />

        {/* ── Center label ── */}
        <div className="globe-center-label">
          <div className="globe-status-text">
            <span className="live-dot" style={{ background: isTouring ? 'var(--warning)' : 'var(--success)', boxShadow: `0 0 8px ${isTouring ? 'var(--warning)' : 'var(--success)'}` }} /> 
            {isTouring ? 'AUTONOMOUS RECON ACTIVE' : 'SATELLITE LINK ACTIVE'}
          </div>
        </div>
      </div>

      {/* ── HUD Overlay Layer ────── */}
      <div className="globe-hud-layer">
        
        {/* TOP SECTION: Header & Actions */}
        <div className="globe-hud-top">
          {/* Top Left: Controls */}
          <div className="globe-hud-actions pointer-auto">
            <button onClick={togglePause} className="btn sm glass-btn">
              {isPaused ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button onClick={toggleFullscreen} className="btn sm glass-btn">
              {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button 
              onClick={toggleTour}
              className={`btn sm glass-btn ${isTouring ? 'tour-active' : ''}`}
            >
              <Target size={14} className={isTouring ? 'pulse' : ''} />
              {isTouring ? 'TOURING' : 'AUTO-TOUR'}
            </button>
          </div>

          {/* Top Center: Title */}
          <div className="globe-hud-header pointer-auto">
            <div className="atlas-logo">
              <Globe2 size={28} />
            </div>
            <h2 className="atlas-title">ATLAS COMMAND</h2>
            <div className="atlas-subtitle">Global Reconnaissance</div>
          </div>

          {/* Top Right: Placeholder for symmetry */}
          <div className="globe-hud-actions right pointer-auto" style={{ opacity: 0, pointerEvents: 'none' }}>
             <button className="btn sm glass-btn"><Search size={16} /></button>
          </div>
        </div>

        {/* BOTTOM SECTION: Stats, Search & Active Nodes */}
        <div className="globe-hud-bottom pointer-auto">
          
          <div className="globe-glass-panel">
            {/* Quick Stats */}
            <div className="globe-stats-grid">
              <StatBox icon={<Building2 size={16} />} label="Total Spaces" value={totalSpaces} color="#3b82f6" />
              <StatBox icon={<MapPin size={16} />} label="Cities" value={totalCities} color="#8b5cf6" />
              <StatBox icon={<Dumbbell size={16} />} label="Reviews" value={totalReviews} color="#10b981" />
              <StatBox icon={<Search size={16} />} label="Nodes" value={dynamicMarkers.length} color="#06b6d4" />
            </div>

            <div className="globe-bottom-divider" />

            {/* Deploy New City */}
            <form onSubmit={handleCrawlCity} className="globe-deploy-form">
               <input 
                 type="text" 
                 className="globe-deploy-input" 
                 placeholder="Enter city to deploy scraper..." 
                 value={newCityName}
                 onChange={e => setNewCityName(e.target.value)}
                 disabled={isGeocoding}
               />
               <button type="submit" className="btn accent globe-deploy-btn" disabled={!newCityName.trim() || isGeocoding}>
                  {isGeocoding ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }}/> : <Play size={14} fill="currentColor" />} DEPLOY
               </button>
            </form>

            {/* Active Nodes Horizontal Carousel */}
            <div className="globe-nodes-carousel custom-scrollbar">
              <AnimatePresence>
              {sortedMarkers.map((city, i) => {
                const count = cityStats[city.name?.toLowerCase()] || 0;
                const isHovered = hoveredCity === city.name;
                const isQueued = city.isQueued;
                const color = isQueued ? '#f59e0b' : (count > 100 ? '#8b5cf6' : count > 30 ? '#10b981' : count > 0 ? '#3b82f6' : '#64748b');
                
                return (
                  <motion.div
                    key={city.name}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.02, duration: 0.3 }}
                    onHoverStart={() => setHoveredCity(city.name)}
                    onHoverEnd={() => setHoveredCity(null)}
                    onClick={() => handleCityClick(city)}
                    className={`node-chip ${isHovered ? 'hovered' : ''}`}
                    style={{ '--node-color': color }}
                  >
                    <div className="node-indicator">
                      <div className="node-dot" />
                      {(isQueued || isHovered) && <motion.div className="node-pulse" animate={{ scale: [1, 2.5], opacity: [0.8, 0] }} transition={{ repeat: Infinity, duration: 1.5 }} />}
                    </div>
                    <span className="node-name">{city.name}</span>
                    <span className="node-count">{count > 0 ? count.toLocaleString() : '—'}</span>
                  </motion.div>
                );
              })}
              </AnimatePresence>
            </div>
          </div>

        </div>
      </div>

      <style>{`
        /* ── Fresh Symmetric Layout ── */
        .globe-page-container {
          position: relative;
          height: calc(100vh - 100px);
          overflow: hidden;
          background: radial-gradient(circle at center, rgba(15, 23, 42, 1) 0%, rgba(0,0,0,1) 100%);
        }
        
        .globe-canvas-wrapper {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          cursor: grab; z-index: 1;
        }

        .globe-ambient-glow {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
          width: 70vw; height: 70vw; max-width: 800px; max-height: 800px;
          background: radial-gradient(circle, var(--accent) 0%, transparent 60%);
          opacity: 0.08; pointer-events: none; filter: blur(60px); z-index: 0;
        }

        .globe-center-label {
          position: absolute; top: 50%; left: 50%; transform: translate(-50%, 200px);
          text-align: center; pointer-events: none; z-index: 5;
        }
        .globe-status-text {
          font-size: 10px; color: var(--accent); font-weight: 700;
          text-transform: uppercase; letter-spacing: 2px; font-family: var(--mono);
          display: flex; align-items: center; justify-content: center; gap: 6px;
          background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(8px);
          padding: 6px 16px; border-radius: 20px; border: 1px solid rgba(139, 92, 246, 0.15);
        }

        /* ── HUD Layer ── */
        .globe-hud-layer {
          position: absolute; inset: 0; z-index: 10;
          pointer-events: none;
          display: flex; flex-direction: column; justify-content: space-between;
          padding: 24px;
        }
        .pointer-auto { pointer-events: auto; }

        .globe-hud-top {
          display: flex; justify-content: space-between; align-items: flex-start;
          width: 100%; max-width: 1200px; margin: 0 auto;
        }

        .globe-hud-actions {
          display: flex; gap: 8px; flex: 1;
        }
        .globe-hud-actions.right { justify-content: flex-end; }

        .glass-btn {
          background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary);
        }
        .glass-btn:hover { background: rgba(15, 23, 42, 0.8); border-color: var(--accent); color: var(--accent); }
        .glass-btn.tour-active { color: var(--warning); border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.15); }

        .globe-hud-header {
          display: flex; flex-direction: column; align-items: center; flex: 1;
        }
        .atlas-logo {
          padding: 10px; background: rgba(139, 92, 246, 0.15); border-radius: 50%;
          border: 1px solid rgba(139, 92, 246, 0.3); margin-bottom: 8px;
          box-shadow: 0 0 24px rgba(139, 92, 246, 0.3); color: var(--accent);
        }
        .atlas-title {
          font-size: 20px; font-weight: 900; letter-spacing: 3px; color: #fff;
          text-shadow: 0 0 20px rgba(139,92,246,0.6); margin: 0 0 4px 0; text-align: center;
        }
        .atlas-subtitle {
          font-size: 9px; color: var(--accent); font-weight: 700; letter-spacing: 2px;
          text-transform: uppercase; font-family: var(--mono); text-align: center;
        }

        .globe-hud-bottom {
          display: flex; flex-direction: column; gap: 16px;
          width: 100%; max-width: 800px; margin: 0 auto;
        }

        .globe-glass-panel {
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.6) 0%, rgba(10, 14, 26, 0.8) 100%);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          padding: 20px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
        }

        .globe-stats-grid {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px;
        }

        .globe-bottom-divider {
          height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
          margin: 16px 0;
        }

        .globe-deploy-form {
          display: flex; gap: 8px; padding: 6px;
          background: rgba(0,0,0,0.3); border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.05);
          box-shadow: inset 0 2px 10px rgba(0,0,0,0.2);
          margin-bottom: 16px;
        }
        .globe-deploy-input {
          flex: 1; background: transparent; border: none; padding: 8px 16px;
          font-size: 13px; color: #fff; outline: none; font-family: var(--font);
        }
        .globe-deploy-btn {
          padding: 8px 20px; border-radius: 12px; font-weight: 700; letter-spacing: 1px;
        }

        .globe-nodes-carousel {
          display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;
          -webkit-overflow-scrolling: touch; scrollbar-width: none;
        }
        .globe-nodes-carousel::-webkit-scrollbar { display: none; }
        
        .node-chip {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 14px; border-radius: 20px;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05);
          cursor: pointer; transition: all 0.2s; white-space: nowrap; flex-shrink: 0;
        }
        .node-chip.hovered {
          background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15);
          transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .node-indicator { position: relative; width: 8px; height: 8px; }
        .node-dot {
          position: absolute; inset: 0; border-radius: 50%; background: var(--node-color);
          box-shadow: 0 0 8px var(--node-color); opacity: 0.8;
        }
        .node-chip.hovered .node-dot { opacity: 1; }
        .node-pulse { position: absolute; inset: 0; border-radius: 50%; background: var(--node-color); }
        .node-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
        .node-count { font-size: 12px; font-family: var(--mono); color: var(--node-color); font-weight: 700; }

        /* ── Mobile Responsive Overrides ── */
        @media (max-width: 768px) {
          .globe-hud-layer { padding: 12px; }
          .globe-hud-top { flex-direction: column-reverse; align-items: center; gap: 16px; margin-top: 10px; }
          .globe-hud-actions { width: 100%; justify-content: center; }
          .globe-hud-actions.right { display: none; }
          
          .globe-stats-grid { grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
          .globe-glass-panel { padding: 16px; border-radius: 20px; }
          .globe-center-label { transform: translate(-50%, 150px); }
          .atlas-title { font-size: 18px; letter-spacing: 2px; }
          .atlas-logo { padding: 8px; }
          .atlas-logo svg { width: 20px; height: 20px; }
        }

        .live-dot {
          width: 6px; height: 6px; background: var(--success); border-radius: 50%;
          box-shadow: 0 0 8px var(--success); animation: pulse-dot 2s infinite;
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.2); }
        }

        /* ── CREATIVE UI EFFECTS ── */
        .hud-grid {
          position: absolute; inset: -100%;
          background-image: 
            linear-gradient(rgba(139, 92, 246, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(139, 92, 246, 0.1) 1px, transparent 1px);
          background-size: 40px 40px;
          transform: perspective(600px) rotateX(60deg) translateY(-100px) translateZ(-200px);
          animation: grid-move 10s linear infinite; opacity: 0.4; pointer-events: none;
        }
        @keyframes grid-move {
          0% { transform: perspective(600px) rotateX(60deg) translateY(0) translateZ(-200px); }
          100% { transform: perspective(600px) rotateX(60deg) translateY(40px) translateZ(-200px); }
        }

        .radar-sweep {
          position: absolute; top: 50%; left: 50%;
          width: 1000px; height: 1000px; margin-top: -500px; margin-left: -500px;
          border-radius: 50%;
          background: conic-gradient(from 0deg, transparent 70%, rgba(139, 92, 246, 0.05) 90%, rgba(139, 92, 246, 0.3) 100%);
          animation: radar-spin 4s linear infinite; pointer-events: none;
        }
        @keyframes radar-spin { 100% { transform: rotate(360deg); } }

        .corner-bracket {
          position: absolute; width: 40px; height: 40px;
          border: 2px solid rgba(139, 92, 246, 0.4); transition: all 0.3s;
        }
        .corner-bracket.top-left { top: 20px; left: 20px; border-right: none; border-bottom: none; }
        .corner-bracket.top-right { top: 20px; right: 20px; border-left: none; border-bottom: none; }
        .corner-bracket.bottom-left { bottom: 20px; left: 20px; border-right: none; border-top: none; }
        .corner-bracket.bottom-right { bottom: 20px; right: 20px; border-left: none; border-top: none; }
      `}</style>
    </motion.div>
  );
}

function TelemetryOverlay({ isTouring, isPaused }) {
  const [hex1, setHex1] = useState('0x0000');
  const [hex2, setHex2] = useState('0x0000');
  const [lat, setLat] = useState('0.0000');
  const [lng, setLng] = useState('0.0000');
  
  useEffect(() => {
    if (isPaused) return;
    const int = setInterval(() => {
      setHex1('0x' + Math.floor(Math.random() * 65535).toString(16).toUpperCase().padStart(4, '0'));
      setHex2('0x' + Math.floor(Math.random() * 65535).toString(16).toUpperCase().padStart(4, '0'));
      setLat((Math.random() * 180 - 90).toFixed(4));
      setLng((Math.random() * 360 - 180).toFixed(4));
    }, 150);
    return () => clearInterval(int);
  }, [isPaused]);

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 1 }}>
      <div className="hud-grid" />
      {!isPaused && <div className="radar-sweep" />}

      <div style={{ position: 'absolute', top: 24, left: 24, color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.8, textShadow: '0 0 8px rgba(139,92,246,0.5)' }}>
        SYS.CORE.OP: {isPaused ? 'STANDBY' : 'NOMINAL'}<br/>
        UPLINK_HASH: <span style={{ color: '#fff' }}>{hex1}</span><br/>
        MEM_OFFSET : <span style={{ color: '#fff' }}>{hex2}</span>
      </div>
      
      <div style={{ position: 'absolute', bottom: 24, right: 24, color: isTouring ? 'var(--warning)' : 'var(--success)', fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.8, textAlign: 'right', textShadow: `0 0 8px ${isTouring ? 'var(--warning)' : 'var(--success)'}` }}>
        TRK_LAT: <span style={{ color: '#fff' }}>{lat}</span><br/>
        TRK_LNG: <span style={{ color: '#fff' }}>{lng}</span><br/>
        <div style={{ marginTop: 4, fontWeight: 700 }}>[{isTouring ? 'AUTO-TRACKING' : 'MANUAL OVERRIDE'}]</div>
      </div>

      <div className="corner-bracket top-left" />
      <div className="corner-bracket top-right" />
      <div className="corner-bracket bottom-left" />
      <div className="corner-bracket bottom-right" />
    </div>
  );
}

function StatBox({ icon, label, value, color }) {
  return (
    <motion.div
      whileHover={{ y: -2, borderColor: color, boxShadow: `0 8px 24px ${color}20` }}
      style={{
        padding: '12px 16px', borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.05)', 
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(10px)',
        transition: 'all 0.3s ease',
        cursor: 'default',
        position: 'relative', overflow: 'hidden'
      }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: 2, height: '100%', background: color, opacity: 0.8, boxShadow: `0 0 10px ${color}` }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, color }}>
        <div style={{ padding: 4, background: `${color}15`, borderRadius: 6 }}>{icon}</div>
        <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div style={{
        fontSize: 22, fontWeight: 900, color: '#fff',
        fontVariantNumeric: 'tabular-nums', textShadow: '0 2px 10px rgba(0,0,0,0.3)'
      }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </motion.div>
  );
}

