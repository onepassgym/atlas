import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Gamepad2, ShieldCheck, Database, LayoutGrid, Trophy, X, Maximize2 } from 'lucide-react';
import MovingPuzzle    from '../components/MovingPuzzle';
import Game2048        from '../components/Game2048';
import XOGame          from '../components/XOGame';
import MastermindGame  from '../components/MastermindGame';
import { SIM }          from '../components/simUI';

const MODULES = [
  {
    key:   'codebreak',
    code:  'MODULE_01',
    name:  'CODEBREAK',
    icon:  Trophy,
    color: SIM.red,
    rgb:   '248,113,113',
    desc:  'Deduce the hidden 4-peg sequence in 8 guesses or less. Black pegs confirm position, white pegs confirm color.',
    game:  MastermindGame,
  },
  {
    key:   'decrypt',
    code:  'MODULE_02',
    name:  'BYPASS_X',
    icon:  ShieldCheck,
    color: SIM.green,
    rgb:   '16,185,129',
    desc:  'Realign encrypted data nodes to establish a secure bypass. Precision over speed.',
    game:  MovingPuzzle,
  },
  {
    key:   'fusion',
    code:  'MODULE_03',
    name:  'DATA_FUSION',
    icon:  Database,
    color: SIM.purple,
    rgb:   '139,92,246',
    desc:  'Merge identical data blocks to compress the matrix. Reach 2048 to stabilize the core.',
    game:  Game2048,
  },
  {
    key:   'grid',
    code:  'MODULE_04',
    name:  'TACTICAL_GRID',
    icon:  LayoutGrid,
    color: SIM.orange,
    rgb:   '249,115,22',
    desc:  'Outwit the adversarial AI on a 3×3 strategic grid. Challenge a partner or face Minimax.',
    game:  XOGame,
  },
];

export default function SimulationsPage() {
  const [zoomedKey, setZoomedKey] = useState(null);

  useEffect(() => {
    if (!zoomedKey) return;
    const onKey = (e) => { if (e.key === 'Escape') setZoomedKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomedKey]);

  return (
    <motion.div
      initial={{ opacity:0, y:16 }}
      animate={{ opacity:1, y:0 }}
      exit={{ opacity:0, y:-16 }}
      className="page-container"
      style={{ padding:'24px', display:'flex', flexDirection:'column', gap:'32px' }}
    >
      <style>{`
        /* Responsive 3→2→1 column grid */
        .sim-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
          width: 100%;
          align-items: start;   /* each column natural height */
        }
        @media (max-width: 1100px) {
          .sim-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 640px) {
          .sim-grid { grid-template-columns: 1fr; }
        }

        /* Module column: label + desc + card stack. This wrapper is always
           present (zoomed or not) so the game inside it never changes tree
           position — only its class/style toggles — which keeps React from
           unmounting it (and losing its state) when zoom is toggled. */
        .sim-module-inner {
          display: flex;
          flex-direction: column;
          gap: 10px;
          width: 100%;
        }

        /* Game card shell — consistent padding and look */
        .sim-card-shell {
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--bg-surface);
          padding: 14px;
        }

        /* Clickable "zoom into this module" affordances */
        .sim-pill, .sim-module-label {
          cursor: pointer;
          transition: transform 0.15s ease, filter 0.15s ease;
          background: none;
          border: none;
          font: inherit;
          text-align: left;
        }
        .sim-pill:hover, .sim-module-label:hover { transform: translateY(-1px); filter: brightness(1.25); }
        .sim-module-label .sim-zoom-hint { opacity: 0; transition: opacity 0.15s ease; }
        .sim-module-label:hover .sim-zoom-hint { opacity: 1; }

        /* Zoomed state: the module's own wrapper becomes a fullscreen,
           flex-centered backdrop — the game card inside it is the same
           mounted instance as in the grid, just repositioned, so its state
           (an in-progress round, timers, etc.) survives zooming in and out. */
        .sim-module.sim-module-zoomed {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0,0,0,0.78);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          cursor: default;
        }
        .sim-zoom-panel {
          width: min(520px, 100%);
          max-height: 92vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px;
          box-shadow: 0 24px 70px rgba(0,0,0,0.6);
        }
      `}</style>

      {/* ── Page Header ── */}
      <div style={{
        display:'flex', alignItems:'center', gap:16,
        borderBottom:'1px solid var(--border)', paddingBottom:24,
        flexWrap:'wrap', rowGap:12,
      }}>
        <div style={{
          padding:12, background:'rgba(139,92,246,0.08)',
          borderRadius:8, border:'1px solid rgba(139,92,246,0.2)', flexShrink:0,
        }}>
          <Gamepad2 size={26} color={SIM.purple}/>
        </div>
        <div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:900, letterSpacing:-0.5, color:'var(--text-primary)' }}>
            TRAINING SIMULATIONS
          </h1>
          <p style={{
            margin:'4px 0 0 0', fontSize:11, color:'var(--text-muted)',
            fontFamily:SIM.font, textTransform:'uppercase', letterSpacing:1.2,
          }}>
            Operator Cognitive Testing Facility · 4 Modules Active
          </p>
        </div>

        {/* Status pills — click to zoom into that module */}
        <div style={{ marginLeft:'auto', display:'flex', gap:8, flexWrap:'wrap' }}>
          {MODULES.map(m => (
            <button
              key={m.key}
              className="sim-pill"
              onClick={() => setZoomedKey(m.key)}
              title={`Zoom into ${m.name}`}
              style={{
                display:'flex', alignItems:'center', gap:6,
                padding:'5px 10px',
                background:`rgba(${m.rgb},0.08)`,
                border:`1px solid rgba(${m.rgb},0.25)`,
                borderRadius:3,
              }}
            >
              <div style={{ width:5, height:5, borderRadius:'50%', background:m.color, boxShadow:`0 0 5px ${m.color}` }}/>
              <span style={{ fontSize:9, fontWeight:700, color:m.color, fontFamily:SIM.font, letterSpacing:1 }}>
                {m.code}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Module Grid ── */}
      <div className="sim-grid">
        {MODULES.map((m, i) => {
          const GameComp = m.game;
          const isZoomed = m.key === zoomedKey;
          const gameProps = m.key === 'grid' ? {
            onWin:  (w) => console.log(`[TACTICAL] winner: ${w}`),
            onDraw: ()  => console.log('[TACTICAL] draw'),
          } : {};

          // Same GameComp element either way — zooming only changes the
          // wrapper's CSS (fullscreen backdrop vs. normal grid cell), it
          // never unmounts/remounts the game, so in-progress state (an
          // active round, timers, etc.) survives clicking out.
          const body = (
            <>
              {/* Module label row — click to zoom into this module */}
              <button
                className="sim-module-label"
                onClick={() => setZoomedKey(isZoomed ? null : m.key)}
                title={isZoomed ? 'Close' : `Zoom into ${m.name}`}
                style={{ display:'flex', alignItems:'center', gap:8, padding:0 }}
              >
                <m.icon size={14} color={m.color}/>
                <div style={{
                  fontSize:9, fontWeight:900, color:m.color,
                  fontFamily:SIM.font, letterSpacing:1.5, textTransform:'uppercase',
                }}>
                  {m.code}: {m.name}
                </div>
                {isZoomed
                  ? <X size={12} color={m.color} style={{ marginLeft:'auto' }} />
                  : <Maximize2 size={11} color={m.color} className="sim-zoom-hint" />}
              </button>

              {/* Description */}
              <p style={{
                margin:0, fontSize:12, color:'var(--text-muted)',
                lineHeight:1.65,
              }}>
                {m.desc}
              </p>

              {/* Game card */}
              <div className="sim-card-shell">
                <GameComp {...gameProps} />
              </div>
            </>
          );

          return (
            <motion.div
              key={m.key}
              className={`sim-module ${isZoomed ? 'sim-module-zoomed' : ''}`}
              initial={{ opacity:0, y:20 }}
              animate={{ opacity:1, y:0 }}
              transition={{ delay: i * 0.07 }}
              onClick={isZoomed ? () => setZoomedKey(null) : undefined}
            >
              {/* Always the same wrapper element at the same tree position —
                  only its class/onClick change with zoom state — so GameComp
                  never unmounts and its in-progress state survives. */}
              <div
                className={`sim-module-inner ${isZoomed ? 'sim-zoom-panel' : ''}`}
                onClick={isZoomed ? (e => e.stopPropagation()) : undefined}
              >
                {body}
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
