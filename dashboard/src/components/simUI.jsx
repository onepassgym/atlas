// Simulation Design System — shared tokens for all 3 game modules
// Import this in MovingPuzzle, Game2048, and XOGame

export const SIM = {
  // Surfaces
  bg:          'rgba(10, 14, 25, 0.95)',
  bgSurface:   'rgba(255,255,255,0.04)',
  bgHover:     'rgba(255,255,255,0.08)',

  // Accent palette
  purple:      '#a78bfa',
  green:       '#34d399',
  orange:      '#fb923c',
  red:         '#f87171',

  // Border states
  bdIdle:      'rgba(255,255,255,0.12)',
  bdActive:    '#a78bfa',
  bdWin:       '#34d399',

  // Text
  txPrimary:   'rgba(255,255,255,0.95)',
  txSecondary: 'rgba(255,255,255,0.65)',
  txMuted:     'rgba(255,255,255,0.40)',

  // Shadows
  shIdle:      '0 8px 24px rgba(0,0,0,0.6)',
  shActive:    '0 0 0 1px rgba(167,139,250,0.4), 0 12px 40px rgba(167,139,250,0.2)',
  shWin:       '0 0 0 1px rgba(52,211,153,0.4), 0 12px 40px rgba(52,211,153,0.2)',

  // Font
  font:        "var(--mono, 'Inter', 'Roboto', monospace)",
};

/** Returns the shared card wrapper style */
export function simCard(isActive, isWin) {
  return {
    background:     SIM.bg,
    backdropFilter: 'blur(20px)',
    border:         `1px solid ${isActive ? SIM.bdActive : isWin ? SIM.bdWin : SIM.bdIdle}`,
    boxShadow:       isActive ? SIM.shActive : isWin ? SIM.shWin : SIM.shIdle,
    borderRadius:   4,
    overflow:       'hidden',
    fontFamily:     SIM.font,
    transition:     'border-color 0.2s ease, box-shadow 0.2s ease',
    outline:        'none',
    width:          '100%',
    position:       'relative',
  };
}

/** Header bar for each game module */
export function simHeader(accentRgb) {
  return {
    background:   `rgba(${accentRgb}, 0.12)`,
    borderBottom: `1px solid rgba(${accentRgb}, 0.25)`,
    padding:      '10px 14px',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'space-between',
  };
}

/** Footer bar */
export const simFooter = {
  borderTop:      '1px solid rgba(255,255,255,0.05)',
  padding:        '10px 14px',
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
};

/** Icon button (returns inline styles but you should also add className="sim-icon-btn") */
export function simIconBtn(active = false) {
  return {
    background:  active ? 'rgba(167,139,250,0.15)' : 'transparent',
    border:      'none',
    padding:     6,
    cursor:      'pointer',
    color:       active ? SIM.purple : SIM.txMuted,
    display:     'flex',
    alignItems:  'center',
    lineHeight:  1,
    transition:  'all 0.15s ease',
    borderRadius: 4,
  };
}

/** Status badge text style */
export function simStatus(isActive) {
  return {
    fontSize:      9,
    fontWeight:    700,
    letterSpacing: 1.2,
    color:         isActive ? SIM.purple : SIM.txMuted,
    transition:    'color 0.2s',
    textTransform: 'uppercase',
  };
}

// Inject mobile styles
let _mobileStylesInjected = false;
function injectMobileStyles() {
  if (typeof document === 'undefined' || _mobileStylesInjected) return;
  _mobileStylesInjected = true;
  const el = document.createElement('style');
  el.textContent = `
    @media (max-width: 768px) {
      .mobile-fullscreen-active {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100dvh !important;
        z-index: 9999 !important;
        border-radius: 0 !important;
        margin: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        overscroll-behavior: none !important;
        touch-action: none !important;
      }
    }
    
    @media (pointer: coarse) {
      .dpad-container {
        display: grid !important;
      }
    }
    
    .sim-icon-btn {
      transition: all 0.2s ease;
    }
    .sim-icon-btn:hover {
      background: rgba(255,255,255,0.1) !important;
      color: rgba(255,255,255,0.9) !important;
      transform: translateY(-1px);
    }
    .sim-icon-btn:active {
      transform: translateY(1px);
    }
  `;
  document.head.appendChild(el);
}

export function MobileDPad({ onDirection }) {
  if (typeof window === 'undefined') return null;
  
  const btnStyle = {
    width: 56,
    height: 56,
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 8,
    color: 'rgba(255,255,255,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  };

  const handlePress = (dir, e) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.style.transform = 'scale(0.9)';
    el.style.background = 'rgba(255,255,255,0.25)';
    setTimeout(() => {
      el.style.transform = 'scale(1)';
      el.style.background = 'rgba(255,255,255,0.1)';
    }, 100);
    onDirection(dir);
  };

  return (
    <div className="dpad-container" style={{
      display: 'none', // hidden on desktop via media query
      gridTemplateColumns: 'repeat(3, 56px)',
      gap: 10,
      position: 'fixed',
      bottom: 40,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 10000,
      padding: 16,
      background: 'rgba(0,0,0,0.5)',
      backdropFilter: 'blur(10px)',
      borderRadius: 16,
    }}>
      <div />
      <div style={btnStyle} onTouchStart={(e) => handlePress('up', e)}>▲</div>
      <div />
      <div style={btnStyle} onTouchStart={(e) => handlePress('left', e)}>◄</div>
      <div style={btnStyle} onTouchStart={(e) => handlePress('down', e)}>▼</div>
      <div style={btnStyle} onTouchStart={(e) => handlePress('right', e)}>►</div>
    </div>
  );
}

import { useEffect } from 'react';

export function useGameMobileFix(isActive, ref, onSwipe) {
  // Inject mobile styles when hook is used
  if (typeof document !== 'undefined') injectMobileStyles();

  // Handle active fold / body lock
  useEffect(() => {
    if (isActive) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overscrollBehavior = 'none';
      document.body.style.overscrollBehavior = 'none';
      document.documentElement.style.overscrollBehaviorX = 'none';
      
      if (ref.current) {
        ref.current.focus({ preventScroll: true });
      }
    } else {
      document.body.style.overflow = '';
      document.documentElement.style.overscrollBehavior = '';
      document.body.style.overscrollBehavior = '';
      document.documentElement.style.overscrollBehaviorX = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.documentElement.style.overscrollBehavior = '';
      document.body.style.overscrollBehavior = '';
      document.documentElement.style.overscrollBehaviorX = '';
    };
  }, [isActive, ref]);

  // Handle native touch events with { passive: false }
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let touchStartX = 0;
    let touchStartY = 0;

    const onTouchStart = (e) => {
      if (!isActive) return;
      if (e.target.closest('button')) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    };

    const onTouchMove = (e) => {
      if (!isActive) return;
      if (e.target.closest('button')) return;
      e.preventDefault(); // Prevent native scroll
    };

    const onTouchEnd = (e) => {
      if (!isActive) return;
      if (e.target.closest('button')) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      
      if (onSwipe) {
        if (Math.abs(dx) > Math.abs(dy)) {
          if (Math.abs(dx) > 30) onSwipe(dx > 0 ? 'right' : 'left');
        } else {
          if (Math.abs(dy) > 30) onSwipe(dy > 0 ? 'down' : 'up');
        }
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [isActive, ref, onSwipe]);
}

// ── Win celebration ──────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#22d3ee', '#f472b6'];

/**
 * Bursts confetti across the whole viewport (a fixed full-screen canvas
 * appended to <body>, not scoped to the calling game's card) and cleans
 * itself up when the animation finishes. No dependency — plain canvas.
 */
export function fireConfetti({ duration = 2600, particleCount = 180 } = {}) {
  if (typeof document === 'undefined') return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const size = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  window.addEventListener('resize', size);

  const particles = Array.from({ length: particleCount }, () => ({
    x: Math.random() * window.innerWidth,
    y: -20 - Math.random() * window.innerHeight * 0.5,
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 3,
    size: 5 + Math.random() * 5,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    rotation: Math.random() * 360,
    vr: (Math.random() - 0.5) * 12,
    shape: Math.random() < 0.5 ? 'rect' : 'circle',
    tilt: Math.random() * Math.PI,
  }));

  const start = performance.now();
  const fadeStart = duration - 500;

  const frame = (now) => {
    const elapsed = now - start;
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    const alpha = elapsed > fadeStart ? Math.max(0, 1 - (elapsed - fadeStart) / 500) : 1;

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.03; // gravity
      p.rotation += p.vr;
      p.tilt += 0.05;
      const swing = Math.sin(p.tilt) * 1.5;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x + swing, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', size);
      canvas.remove();
    }
  };
  requestAnimationFrame(frame);

  // Backstop: browsers throttle/pause rAF in backgrounded tabs, which could
  // otherwise leave the canvas stuck on screen if the tab stays hidden past
  // `duration`. remove()/removeEventListener are no-ops if already cleaned up.
  setTimeout(() => {
    window.removeEventListener('resize', size);
    canvas.remove();
  }, duration + 500);
}
