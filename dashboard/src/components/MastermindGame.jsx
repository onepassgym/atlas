// <MastermindGame onWin={(guesses) => console.log('cracked in ' + guesses)} onLose={() => console.log('code not cracked')} />
// Classic Mastermind: crack a hidden 4-peg code (duplicates allowed) in 8 or
// fewer guesses (or unlimited, in infinite mode). Black peg = right value +
// position, white peg = right value, wrong position. Values can be shown as
// colors or as numbers — same scoring logic either way.
//
// Two modes:
//  - SOLO: crack a randomly generated code.
//  - 2 PLAYERS (pass & play): Player 1 sets a secret code, passes the device,
//    then Player 2 guesses it. Both phases run their own live stopwatch.
//
// Win/loss results and aggregate stats (wins/losses/best) are persisted
// server-side via /api/games — see src/api/gameRoutes.js on the backend.

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { RefreshCw, RotateCcw, Eraser, Trophy, Users, Shuffle, EyeOff, Lock, Timer, BookOpen, X, Maximize2, Minimize2, Check } from 'lucide-react';
import { SIM, simCard, simHeader, simFooter, simIconBtn, simStatus, useGameMobileFix, fireConfetti } from './simUI';
import { api } from '../api/client';

const ACCENT_RGB    = '248,113,113'; // red (Player 1 / solo)
const P2_ACCENT_RGB = '167,139,250'; // purple (Player 2's turn)
const CODE_LENGTH   = 4;
const MAX_GUESSES   = 8;
// Difficulty only changes how many of these values are in play — the first
// N are used, so Easy is a strict subset of Mid which is a strict subset of Hard.
const PEGS = [
  { key: 'red',    hex: '#f87171' },
  { key: 'orange', hex: '#fb923c' },
  { key: 'yellow', hex: '#fbbf24' },
  { key: 'green',  hex: '#34d399' },
  { key: 'blue',   hex: '#60a5fa' },
  { key: 'purple', hex: '#a78bfa' },
  { key: 'cyan',   hex: '#22d3ee' },
  { key: 'pink',   hex: '#f472b6' },
];
const DIFFICULTY_COLORS = { easy: 4, mid: 6, hard: 8 };

// The values in play, regardless of whether they're displayed as colors or
// numbers — a color swatch backs every value either way, numbers just add a
// digit label on top of it.
function buildActiveValues(colorCount) {
  return Array.from({ length: colorCount }, (_, i) => ({ key: String(i), hex: PEGS[i % PEGS.length].hex, num: i }));
}

function generateSecret(colorCount) {
  return Array.from({ length: CODE_LENGTH }, () => Math.floor(Math.random() * colorCount));
}

// Standard Mastermind scoring: black pegs first (exact matches), then white
// pegs from whatever's left (right value, wrong slot) — each peg on both
// sides can only be consumed once. Values are plain indices, so this logic
// is identical whether they're presented as colors or numbers.
function scoreGuess(secret, guess) {
  let black = 0;
  const secretRest = [], guessRest = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (guess[i] === secret[i]) black++;
    else { secretRest.push(secret[i]); guessRest.push(guess[i]); }
  }
  let white = 0;
  const counts = {};
  for (const c of secretRest) counts[c] = (counts[c] || 0) + 1;
  for (const c of guessRest) { if (counts[c] > 0) { white++; counts[c]--; } }
  return { black, white };
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// A filled peg gets a dartboard-style ring pattern (bullseye + alternating
// bands) instead of a flat fill, built from the peg's own color.
function dartPegBackground(hex) {
  return `radial-gradient(circle at 50% 50%,
    rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.95) 10%,
    ${hex} 11%, ${hex} 32%,
    rgba(0,0,0,0.5) 33%, rgba(0,0,0,0.5) 40%,
    ${hex} 41%, ${hex} 64%,
    rgba(255,255,255,0.3) 65%, rgba(255,255,255,0.3) 72%,
    ${hex} 73%, ${hex} 100%)`;
}

// Color pegs get the full dart-ring treatment; number pegs get a flat tinted
// fill so the printed digit stays legible on top of it.
function pegFill(pegType, value) {
  if (pegType === 'number') {
    return { style: { background: value.hex, boxShadow: `0 0 8px ${value.hex}55` }, label: value.num };
  }
  return { style: { background: dartPegBackground(value.hex), boxShadow: `0 0 8px ${value.hex}66` }, label: null };
}

function PegLabel({ label, size = 13 }) {
  if (label === null || label === undefined) return null;
  return (
    <span style={{ fontSize: size, fontWeight: 900, color: '#fff', fontFamily: SIM.font, textShadow: '0 1px 3px rgba(0,0,0,0.7)', pointerEvents: 'none' }}>
      {label}
    </span>
  );
}

// Counts up in whole seconds while `active` is true, and freezes at its last
// value the moment `active` goes false (auto-resets to 0 on the next start).
function useStopwatch(active) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}

// Inject Mastermind-specific CSS once
let _mmStylesInjected = false;
function injectMastermindStyles() {
  if (_mmStylesInjected) return;
  _mmStylesInjected = true;
  const el = document.createElement('style');
  el.textContent = `
    .mm-slot {
      width: 44px;
      height: 44px;
      justify-self: center;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 1px solid rgba(248,113,113,0.22);
      background: rgba(255,255,255,0.03);
      transition: background 0.15s, border-color 0.15s, transform 0.15s;
    }
    .mm-slot.mm-filled { border-color: rgba(255,255,255,0.2); }
    .mm-slot-pop { animation: mm-pop 160ms ease forwards; }
    @keyframes mm-pop { from { opacity:0; transform:scale(0.5); } to { opacity:1; transform:scale(1); } }

    .mm-row.mm-current .mm-slot:not(.mm-filled) {
      border-color: rgba(248,113,113,0.5);
      box-shadow: 0 0 6px rgba(248,113,113,0.15);
    }
    .mm-row.mm-win .mm-slot.mm-filled { box-shadow: 0 0 8px rgba(52,211,153,0.4); }

    .mm-peg-btn {
      width: 36px;
      height: 36px;
      justify-self: center;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.15);
      cursor: pointer;
      transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
    }
    .mm-peg-btn:hover:not(:disabled) { transform: translateY(-2px); border-color: rgba(255,255,255,0.5); }
    .mm-peg-btn:disabled { cursor: default; opacity: 0.4; }

    .mm-fb-dot { width: 7px; height: 7px; border-radius: 50%; }

    .mm-book-page { scrollbar-width: thin; }
    .mm-book-page::-webkit-scrollbar { width: 6px; }
    .mm-book-page::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 4px; }
  `;
  document.head.appendChild(el);
}

export default function MastermindGame({ onWin, onLose }) {
  const [mode, setMode]           = useState(null); // null|'solo'|'2p'
  const [phase, setPhase]         = useState('setup'); // 2p only: setup|pass|play
  const [setupCode, setSetupCode] = useState([]);   // Player 1's code, built one peg at a time

  // Picker-only selections — snapshotted into colorCount/guessLimit/activePegType
  // when a mode is (re)started, so the picker (unreachable mid-round anyway)
  // never has a chance to desync from the secret's already-chosen value range.
  const [difficulty, setDifficulty]           = useState('mid');   // easy|mid|hard
  const [infiniteGuesses, setInfiniteGuesses] = useState(false);
  const [pegType, setPegType]                 = useState('color'); // color|number
  const [colorCount, setColorCount]           = useState(DIFFICULTY_COLORS.mid);
  const [guessLimit, setGuessLimit]           = useState(MAX_GUESSES); // Infinity when infinite mode is on
  const [activePegType, setActivePegType]     = useState('color');
  const activeValues = buildActiveValues(colorCount);

  const [secret, setSecret]       = useState(() => generateSecret(DIFFICULTY_COLORS.mid));
  const [guesses, setGuesses]     = useState([]);     // [{ code:[...], black, white }]
  const [current, setCurrent]     = useState([]);     // value indices, length < CODE_LENGTH
  const [status, setStatus]       = useState('playing'); // playing|won|lost
  const [popIdx, setPopIdx]       = useState(-1);
  const [stats, setStats]         = useState({ wins: 0, losses: 0 });
  const [best, setBest]           = useState(() => parseInt(localStorage.getItem('atlas-mastermind-best')) || null);
  const [isActive, setIsActive]   = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const gameRef                   = useRef(null);

  useGameMobileFix(isActive, gameRef);
  useEffect(() => { injectMastermindStyles(); }, []);

  // Hydrate wins/losses/best from the DB once on mount — falls back silently
  // to the localStorage best already loaded above if the request fails.
  useEffect(() => {
    api.get('/api/games/mastermind/stats')
      .then(d => {
        if (!d || d.success === false) return;
        setStats({ wins: d.wins ?? 0, losses: d.losses ?? 0 });
        if (typeof d.best === 'number') setBest(d.best);
      })
      .catch(() => {});
  }, []);

  // Escape closes whichever overlay is open
  useEffect(() => {
    if (!showRules && !isFullscreen) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (showRules) setShowRules(false);
      else setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showRules, isFullscreen]);

  // Live while its phase is active, frozen at the final value the instant it isn't.
  const setupElapsed = useStopwatch(mode === '2p' && phase === 'setup');
  const guessElapsed  = useStopwatch(mode === '2p' && phase === 'play' && status === 'playing');

  const inPlayView = mode === 'solo' || phase === 'play';
  const gameOver = status !== 'playing';
  const attemptsUsed = guesses.length;
  const p2Turn = mode === '2p' && phase === 'play';
  const headerRgb   = p2Turn ? P2_ACCENT_RGB : ACCENT_RGB;
  const headerColor = p2Turn ? SIM.purple : SIM.red;

  const awaitingLock = mode === '2p' && !gameOver && current.length === CODE_LENGTH;

  const statusText = () => {
    if (status === 'won')  return `CRACKED IN ${attemptsUsed}`;
    if (status === 'lost') return 'CODE_NOT_CRACKED';
    if (awaitingLock) return 'PLAYER 2 · LOCK YOUR GUESS ▸';
    return guessLimit === Infinity ? `GUESS ${attemptsUsed + 1}` : `GUESS ${attemptsUsed + 1}/${guessLimit}`;
  };
  const statusColor = () => {
    if (status === 'won')  return SIM.green;
    if (status === 'lost') return SIM.red;
    if (awaitingLock) return SIM.purple;
    return headerColor;
  };

  const placePeg = useCallback((colorIdx) => {
    if (gameOver || current.length >= CODE_LENGTH) return;
    setCurrent(prev => [...prev, colorIdx]);
    setPopIdx(current.length);
    setTimeout(() => setPopIdx(-1), 200);
  }, [gameOver, current.length]);

  const undoPeg = useCallback(() => {
    if (gameOver || !current.length) return;
    setCurrent(prev => prev.slice(0, -1));
  }, [gameOver, current.length]);

  const placeSetupPeg = useCallback((colorIdx) => {
    if (setupCode.length >= CODE_LENGTH) return;
    setSetupCode(prev => [...prev, colorIdx]);
    setPopIdx(setupCode.length);
    setTimeout(() => setPopIdx(-1), 200);
  }, [setupCode.length]);

  const undoSetupPeg = useCallback(() => {
    if (!setupCode.length) return;
    setSetupCode(prev => prev.slice(0, -1));
  }, [setupCode.length]);

  const confirmSetupCode = () => {
    if (setupCode.length !== CODE_LENGTH) return;
    setSecret(setupCode);
    setPhase('pass');
  };

  const startGuessing = () => {
    setPhase('play');
    setGuesses([]);
    setCurrent([]);
    setStatus('playing');
  };

  // Scores the filled row and applies its result. Solo triggers this itself
  // the instant the 4th peg lands (see the effect below). 2P instead waits
  // for Player 2 to press LOCK GUESS — a friend's guess shouldn't score
  // itself off a mis-click, so it gets the same explicit confirm step
  // Player 1 already gets when locking their code.
  const submitGuess = useCallback(() => {
    if (gameOver || current.length !== CODE_LENGTH) return;
    const { black, white } = scoreGuess(secret, current);
    const nextGuesses = [...guesses, { code: current, black, white }];
    setGuesses(nextGuesses);
    setCurrent([]);

    const recordResult = (won) => {
      api.post('/api/games/results', {
        game: 'mastermind',
        mode,
        pegType: activePegType,
        difficulty,
        colorCount,
        guessLimit: guessLimit === Infinity ? -1 : guessLimit,
        won,
        guessesUsed: nextGuesses.length,
        timeSeconds: mode === '2p' ? guessElapsed : null,
      }).catch(() => {});
    };

    if (black === CODE_LENGTH) {
      setStatus('won');
      fireConfetti();
      setStats(prev => ({ ...prev, wins: prev.wins + 1 }));
      if (best === null || nextGuesses.length < best) {
        setBest(nextGuesses.length);
        localStorage.setItem('atlas-mastermind-best', nextGuesses.length);
      }
      recordResult(true);
      if (onWin) onWin(nextGuesses.length);
    } else if (nextGuesses.length >= guessLimit) {
      setStatus('lost');
      setStats(prev => ({ ...prev, losses: prev.losses + 1 }));
      recordResult(false);
      if (onLose) onLose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameOver, current, secret, guesses, mode, activePegType, difficulty, colorCount, guessLimit, guessElapsed, best, onWin, onLose]);

  // Solo: auto-score the instant the row fills up.
  useEffect(() => {
    if (mode !== 'solo') return;
    submitGuess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const selectMode = (m) => {
    const cCount = DIFFICULTY_COLORS[difficulty];
    const gLimit = infiniteGuesses ? Infinity : MAX_GUESSES;
    setColorCount(cCount);
    setGuessLimit(gLimit);
    setActivePegType(pegType);
    setMode(m);
    setGuesses([]);
    setCurrent([]);
    setStatus('playing');
    if (m === 'solo') {
      setSecret(generateSecret(cCount));
    } else {
      setPhase('setup');
      setSetupCode([]);
    }
  };

  const changeMode = () => {
    setMode(null);
    setPhase('setup');
    setSetupCode([]);
    setGuesses([]);
    setCurrent([]);
    setStatus('playing');
    setIsFullscreen(false);
  };

  const newGame = () => {
    if (mode === '2p') {
      setPhase('setup');
      setSetupCode([]);
    } else {
      setSecret(generateSecret(colorCount));
    }
    setGuesses([]);
    setCurrent([]);
    setStatus('playing');
  };
  const resetStats = () => { setStats({ wins: 0, losses: 0 }); newGame(); };

  // Finite modes render exactly `guessLimit` rows. Infinite mode keeps at
  // least 8 rows on screen at all times (matching the classic board), and
  // grows one row at a time once play actually goes past that.
  const rowCount = guessLimit === Infinity ? Math.max(MAX_GUESSES, guesses.length + 1) : guessLimit;
  const rows = Array.from({ length: rowCount }, (_, i) => {
    if (i < guesses.length) return guesses[i];
    if (i === guesses.length) return { code: current, black: null, white: null, live: true };
    return null;
  });

  // Open-book rules panel — shared by both the mode picker and the game view.
  const ruleBookOverlay = showRules && (
    <div
      onClick={() => setShowRules(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
        zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: 'min(640px, 94vw)', maxHeight: '86vh',
          display: 'flex', background: 'linear-gradient(135deg,#f6ecd9,#eaddc4)', borderRadius: 8,
          boxShadow: '0 24px 70px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.25)', overflow: 'hidden',
        }}
      >
        <div style={{
          position: 'absolute', left: '50%', top: 0, bottom: 0, width: 18, marginLeft: -9,
          background: 'linear-gradient(90deg, rgba(0,0,0,0.18), rgba(0,0,0,0.02) 35%, rgba(0,0,0,0.02) 65%, rgba(0,0,0,0.18))',
          pointerEvents: 'none',
        }} />
        <button
          onClick={() => setShowRules(false)}
          style={{
            position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.08)', border: 'none',
            borderRadius: '50%', width: 26, height: 26, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', zIndex: 2,
          }}
        >
          <X size={14} color="#3a2f22" />
        </button>

        {/* Left page */}
        <div className="mm-book-page" style={{ flex: 1, padding: '28px 24px', overflowY: 'auto', color: '#3a2f22', fontFamily: 'Georgia, serif' }}>
          <div style={{ fontSize: 9, fontWeight: 900, letterSpacing: 2, color: '#b1452e', fontFamily: SIM.font, marginBottom: 6 }}>CODEBREAK</div>
          <h2 style={{ margin: '0 0 14px 0', fontSize: 21, fontWeight: 700 }}>Rule Book</h2>

          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>Objective</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 16px 0' }}>
            Crack the hidden 4-peg code in as few guesses as possible.
          </p>

          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>How to Play</h3>
          <ol style={{ fontSize: 12, lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
            <li>Pick a difficulty (how many values are in play), whether guesses are limited or infinite, and colors or numbers.</li>
            <li>Choose SOLO to crack a randomly generated code, or 2 PLAYERS to pass-and-play with a friend.</li>
            <li>Click a value to place it in the next open slot of your row.</li>
            <li>Once all 4 slots are filled, the row scores itself automatically.</li>
          </ol>
        </div>

        {/* Right page */}
        <div className="mm-book-page" style={{ flex: 1, padding: '28px 24px', overflowY: 'auto', color: '#3a2f22', fontFamily: 'Georgia, serif', borderLeft: '1px solid rgba(0,0,0,0.08)' }}>
          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>Reading Feedback</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 4px 0' }}>
            <strong style={{ color: '#111' }}>● Black peg — correct position &amp; color.</strong> One of your guessed pegs is the <em>exact same value, in the exact same slot,</em> as the secret code. Slot 1 of your guess matches slot 1 of the code, and so on.
          </p>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 10px 0' }}>
            <strong>○ White peg — correct color, wrong position.</strong> One of your guessed pegs has a value that <em>is</em> in the secret code, just not in that slot — e.g. you guessed red in slot 2, and the code does contain red, but in a different slot.
          </p>
          <p style={{ fontSize: 11, lineHeight: 1.6, margin: '0 0 16px 0', color: '#5b4c3a' }}>
            <strong>Example:</strong> code = 🔴🟠🟡🟢. Guess = 🔴🟢🟠🔵 → 1 black (🔴 in slot 1, exact match) + 2 white (🟢 and 🟠 are both in the code, just in different slots) + 🔵 gets nothing (not in the code at all). Each peg in the code is only "used" once, so duplicates can't double-count.
          </p>

          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>Difficulty & Peg Type</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 16px 0' }}>
            Easy uses 4 values, Mid uses 6, Hard uses 8 — as colors or as numbers (0 upward). The code is always 4 pegs long, and values can repeat.
          </p>

          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>Infinite Guesses</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: '0 0 16px 0' }}>
            Turns off the 8-guess limit — keep guessing until you crack it. The board always keeps at least 8 rows visible.
          </p>

          <h3 style={{ fontSize: 13, margin: '0 0 6px 0' }}>2 Players</h3>
          <p style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>
            Player 1 secretly sets the code and passes the device; Player 2 tries to crack it. Both get their own timer.
          </p>
        </div>
      </div>
    </div>
  );

  // ── Mode Picker ──────────────────────────────────────────────────────────
  if (!mode) {
    return (
      <>
      {ruleBookOverlay}
      <div
        ref={gameRef}
        tabIndex={-1}
        onFocus={() => setIsActive(true)}
        onBlur={() => setIsActive(false)}
        className={isActive ? 'mobile-fullscreen-active' : ''}
        style={{ ...simCard(isActive, false), cursor: 'default' }}
      >
        <div style={simHeader(ACCENT_RGB)}>
          <span style={{ fontSize: 9, fontWeight: 900, color: SIM.red, letterSpacing: 1.5 }}>CODEBREAK · SELECT_MODE</span>
          <button onClick={() => setShowRules(true)} className="sim-icon-btn" style={simIconBtn(false)} title="Rule book">
            <BookOpen size={13} />
          </button>
        </div>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 9, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1 }}>
            DIFFICULTY
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['easy', 'mid', 'hard'].map(d => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 3, cursor: 'pointer', fontFamily: SIM.font,
                  fontSize: 9, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase',
                  background: difficulty === d ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${difficulty === d ? SIM.red : 'rgba(255,255,255,0.1)'}`,
                  color: difficulty === d ? SIM.red : SIM.txMuted,
                  transition: 'all 0.15s',
                }}
              >
                {d} · {DIFFICULTY_COLORS[d]}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 9, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1, marginTop: 4 }}>
            PEG TYPE
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[['color', 'COLORS'], ['number', 'NUMBERS']].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setPegType(v)}
                style={{
                  flex: 1, padding: '8px 0', borderRadius: 3, cursor: 'pointer', fontFamily: SIM.font,
                  fontSize: 9, fontWeight: 900, letterSpacing: 1,
                  background: pegType === v ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${pegType === v ? SIM.red : 'rgba(255,255,255,0.1)'}`,
                  color: pegType === v ? SIM.red : SIM.txMuted,
                  transition: 'all 0.15s',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setInfiniteGuesses(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
              padding: '10px 12px', borderRadius: 3, cursor: 'pointer', fontFamily: SIM.font,
              background: infiniteGuesses ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${infiniteGuesses ? SIM.green : 'rgba(255,255,255,0.1)'}`,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 900, color: infiniteGuesses ? SIM.green : SIM.txSecondary, letterSpacing: 0.5 }}>
              ∞ INFINITE GUESSES
            </span>
            <span style={{ fontSize: 9, color: infiniteGuesses ? SIM.green : SIM.txMuted }}>
              {infiniteGuesses ? 'ON · min 8 shown' : `OFF · ${MAX_GUESSES} guesses`}
            </span>
          </button>

          <div style={{ fontSize: 9, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1, marginTop: 4 }}>
            CHOOSE ENGAGEMENT PROTOCOL
          </div>
          <button
            onClick={() => selectMode('solo')}
            style={{
              width: '100%', padding: '14px', background: 'rgba(248,113,113,0.08)',
              border: `1px solid rgba(248,113,113,0.3)`, borderRadius: 3, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10, fontFamily: SIM.font, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.15)'; e.currentTarget.style.borderColor = SIM.red; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)'; }}
          >
            <Shuffle size={16} color={SIM.red} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 11, fontWeight: 900, color: SIM.txPrimary, letterSpacing: 0.5 }}>SOLO</div>
              <div style={{ fontSize: 9, color: SIM.txMuted, marginTop: 2 }}>Crack a randomly generated code</div>
            </div>
          </button>
          <button
            onClick={() => selectMode('2p')}
            style={{
              width: '100%', padding: '14px', background: 'rgba(139,92,246,0.08)',
              border: `1px solid rgba(139,92,246,0.3)`, borderRadius: 3, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10, fontFamily: SIM.font, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(139,92,246,0.15)'; e.currentTarget.style.borderColor = SIM.purple; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(139,92,246,0.08)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,0.3)'; }}
          >
            <Users size={16} color={SIM.purple} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 11, fontWeight: 900, color: SIM.txPrimary, letterSpacing: 0.5 }}>2 PLAYERS</div>
              <div style={{ fontSize: 9, color: SIM.txMuted, marginTop: 2 }}>Pass & play — one sets the code, one cracks it. Both timed.</div>
            </div>
          </button>
        </div>
      </div>
      </>
    );
  }

  // ── Game View ─────────────────────────────────────────────────────────────
  const headerLabel = mode === 'solo' ? 'CODEBREAK · MASTERMIND'
    : phase === 'setup' ? 'CODEBREAK · PLAYER_1_SETUP'
    : phase === 'pass'  ? 'CODEBREAK · PASS_DEVICE'
    : 'CODEBREAK · PLAYER_2_GUESS';

  const STEPS = [
    { key: 'setup', label: 'P1 SETUP' },
    { key: 'pass',  label: 'PASS' },
    { key: 'play',  label: 'P2 GUESS' },
  ];
  const stepIdx = STEPS.findIndex(s => s.key === phase);

  return (
    <>
    {ruleBookOverlay}
    {isFullscreen && (
      <div
        onClick={() => setIsFullscreen(false)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', zIndex: 9998 }}
      />
    )}
    <div
      ref={gameRef}
      tabIndex={-1}
      onFocus={() => setIsActive(true)}
      onBlur={() => setIsActive(false)}
      className={isActive ? 'mobile-fullscreen-active' : ''}
      style={{
        ...simCard(isActive, status === 'won'),
        cursor: 'default',
        // "Full screen" here means pinned to the viewport, not the browser
        // Fullscreen API — keeps the active game area on screen no matter
        // how far the dashboard page itself is scrolled.
        ...(isFullscreen ? {
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(460px, 94vw)', maxHeight: '92vh', overflowY: 'auto', zIndex: 9999,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
        } : {}),
      }}
    >
      {/* Header */}
      <div style={simHeader(headerRgb)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Trophy size={13} color={headerColor} />
          <span style={{ fontSize: 9, fontWeight: 900, color: headerColor, letterSpacing: 1.5, transition: 'color 0.2s' }}>
            {headerLabel}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 8, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 0.5 }}>
            {colorCount}{activePegType === 'number' ? 'N' : 'C'}{guessLimit === Infinity ? ' · ∞' : ''}
          </span>
          <button onClick={() => setShowRules(true)} className="sim-icon-btn" style={simIconBtn(false)} title="Rule book"><BookOpen size={13} /></button>
          <button onClick={() => setIsFullscreen(v => !v)} className="sim-icon-btn" style={simIconBtn(isFullscreen)} title={isFullscreen ? 'Exit full screen' : 'Full screen'}>
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button onClick={newGame}    className="sim-icon-btn" style={simIconBtn(false)} title={mode === '2p' ? 'New round' : 'New code'}><RefreshCw  size={13} /></button>
          <button onClick={changeMode} className="sim-icon-btn" style={simIconBtn(false)} title="Change mode"><RotateCcw size={13} /></button>
        </div>
      </div>

      {/* 2P step tracker + per-player timers */}
      {mode === '2p' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(0,0,0,0.15)' }}>
            {STEPS.map((s, i) => {
              const done = i < stepIdx;
              const current = i === stepIdx;
              const col = current ? (i === 2 ? SIM.purple : SIM.red) : done ? SIM.green : SIM.txMuted;
              return (
                <Fragment key={s.key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{
                      width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 8, fontWeight: 900, flexShrink: 0,
                      background: current || done ? col : 'rgba(255,255,255,0.08)',
                      color: current || done ? '#0a0e19' : SIM.txMuted,
                    }}>
                      {done ? <Check size={9} /> : i + 1}
                    </div>
                    <span style={{ fontSize: 8, fontWeight: 900, letterSpacing: 0.5, color: col, fontFamily: SIM.font }}>{s.label}</span>
                  </div>
                  {i < STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: done ? SIM.green : 'rgba(255,255,255,0.08)' }} />}
                </Fragment>
              );
            })}
          </div>
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.15)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {[
              ['P1 · SETUP', formatTime(setupElapsed), phase === 'setup' ? SIM.red : SIM.txSecondary],
              ['P2 · GUESS', formatTime(guessElapsed), phase === 'play' && status === 'playing' ? SIM.purple : SIM.txSecondary],
            ].map(([lbl, val, col], i) => (
              <div key={lbl} style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRight: i === 0 ? '1px solid rgba(255,255,255,0.05)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                <Timer size={10} color={col} />
                <span style={{ fontSize: 8, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1 }}>{lbl}</span>
                <span style={{ fontSize: 12, fontWeight: 900, color: col, fontFamily: SIM.font }}>{val}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Player 1: set the code ── */}
      {mode === '2p' && phase === 'setup' && (
        <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 10, color: SIM.txSecondary, lineHeight: 1.6 }}>
            <strong style={{ color: SIM.red }}>PLAYER 1:</strong> build a secret 4-peg code. Player 2 won't see this board — pass the device once it's locked.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${CODE_LENGTH},1fr)`, gap: 8, maxWidth: 220 }}>
            {Array.from({ length: CODE_LENGTH }).map((_, s) => {
              const colorIdx = setupCode[s];
              const filled = colorIdx !== undefined;
              const fill = filled ? pegFill(activePegType, activeValues[colorIdx]) : null;
              return (
                <div
                  key={s}
                  className={`mm-slot ${filled ? 'mm-filled' : ''} ${s === popIdx ? 'mm-slot-pop' : ''}`}
                  style={fill?.style}
                >
                  {fill && <PegLabel label={fill.label} size={15} />}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${activeValues.length},1fr)`, gap: 6, flex: 1, maxWidth: activeValues.length * 44 }}>
              {activeValues.map((p, idx) => {
                const fill = pegFill(pegType, p);
                return (
                  <button
                    key={p.key}
                    className="mm-peg-btn"
                    disabled={setupCode.length >= CODE_LENGTH}
                    onClick={() => placeSetupPeg(idx)}
                    title={pegType === 'number' ? String(p.num) : PEGS[idx % PEGS.length].key}
                    style={fill.style}
                  >
                    <PegLabel label={fill.label} size={13} />
                  </button>
                );
              })}
            </div>
            <button
              onClick={undoSetupPeg}
              disabled={!setupCode.length}
              className="sim-icon-btn"
              style={{ ...simIconBtn(false), opacity: !setupCode.length ? 0.35 : 1 }}
              title="Remove last peg"
            >
              <Eraser size={13} />
            </button>
          </div>
          <button
            onClick={confirmSetupCode}
            disabled={setupCode.length !== CODE_LENGTH}
            style={{
              width: '100%', padding: '12px', borderRadius: 3,
              cursor: setupCode.length === CODE_LENGTH ? 'pointer' : 'default',
              background: setupCode.length === CODE_LENGTH ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${setupCode.length === CODE_LENGTH ? SIM.red : 'rgba(255,255,255,0.1)'}`,
              color: setupCode.length === CODE_LENGTH ? SIM.red : SIM.txMuted,
              fontFamily: SIM.font, fontSize: 10, fontWeight: 900, letterSpacing: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            <Lock size={12} /> LOCK CODE & CONTINUE
          </button>
        </div>
      )}

      {/* ── Pass the device ── */}
      {mode === '2p' && phase === 'pass' && (
        <div style={{ padding: '28px 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(248,113,113,0.18), rgba(167,139,250,0.18))',
            border: '1px solid rgba(255,255,255,0.15)',
          }}>
            <EyeOff size={24} color={SIM.txPrimary} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 900, color: SIM.txPrimary, letterSpacing: 0.5 }}>CODE LOCKED</div>
            <div style={{ fontSize: 9, color: SIM.red, marginTop: 4, fontFamily: SIM.font }}>
              PLAYER 1 took {formatTime(setupElapsed)}
            </div>
          </div>
          <div style={{ fontSize: 10, color: SIM.txSecondary, maxWidth: 220, lineHeight: 1.6 }}>
            Hand the device to <strong style={{ color: SIM.purple }}>Player 2</strong>. Don't peek at the board above.
          </div>
          <button
            onClick={startGuessing}
            style={{
              padding: '12px 20px', borderRadius: 3, cursor: 'pointer',
              background: 'rgba(167,139,250,0.12)', border: `1px solid ${SIM.purple}`,
              color: SIM.purple, fontFamily: SIM.font, fontSize: 10, fontWeight: 900, letterSpacing: 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Users size={13} /> PLAYER 2 READY — START GUESSING
          </button>
        </div>
      )}

      {/* ── Guessing board (solo, or Player 2 in 2P) ── */}
      {inPlayView && (
        <>
          {/* Score strip */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.25)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {[['WINS', stats.wins, SIM.green], ['BEST', best ?? '—', SIM.red], ['LOSSES', stats.losses, SIM.txMuted]].map(([lbl, val, col], i) => (
              <div key={lbl} style={{ flex: 1, padding: '7px 0', textAlign: 'center', borderRight: i !== 2 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                <div style={{ fontSize: 8, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1 }}>{lbl}</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: col, fontFamily: SIM.font, lineHeight: 1.2 }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Status bar */}
          <div style={{ padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span style={{ fontSize: 10, fontWeight: 900, color: statusColor(), fontFamily: SIM.font, letterSpacing: 1, transition: 'color 0.2s' }}>
              {statusText()}
            </span>
          </div>

          {/* Board */}
          <div style={{
            padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
            ...(guessLimit === Infinity ? { maxHeight: 340, overflowY: 'auto' } : {}),
          }}>
            {rows.map((row, i) => {
              if (!row) {
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: 0.35 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${CODE_LENGTH},1fr)`, gap: 6, flex: 1 }}>
                      {Array.from({ length: CODE_LENGTH }).map((_, s) => <div key={s} className="mm-slot" />)}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 3, width: 20 }}>
                      {Array.from({ length: 4 }).map((_, d) => <div key={d} className="mm-fb-dot" style={{ background: 'rgba(255,255,255,0.06)' }} />)}
                    </div>
                  </div>
                );
              }
              const isCurrent = !!row.live;
              const isWinRow = status === 'won' && !isCurrent && i === guesses.length - 1;
              const fbPegs = isCurrent ? [] : [
                ...Array(row.black).fill('black'),
                ...Array(row.white).fill('white'),
              ];
              return (
                <div key={i} className={`mm-row ${isCurrent ? 'mm-current' : ''} ${isWinRow ? 'mm-win' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${CODE_LENGTH},1fr)`, gap: 6, flex: 1 }}>
                    {Array.from({ length: CODE_LENGTH }).map((_, s) => {
                      const colorIdx = row.code[s];
                      const filled = colorIdx !== undefined;
                      const fill = filled ? pegFill(activePegType, activeValues[colorIdx]) : null;
                      return (
                        <div
                          key={s}
                          className={`mm-slot ${filled ? 'mm-filled' : ''} ${isCurrent && s === popIdx ? 'mm-slot-pop' : ''}`}
                          style={fill?.style}
                        >
                          {fill && <PegLabel label={fill.label} size={15} />}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 3, width: 20 }}>
                    {Array.from({ length: 4 }).map((_, d) => (
                      <div
                        key={d}
                        className="mm-fb-dot"
                        style={{ background: fbPegs[d] === 'black' ? '#0a0e19' : fbPegs[d] === 'white' ? '#e5e7eb' : 'rgba(255,255,255,0.06)', border: fbPegs[d] === 'black' ? '1px solid rgba(255,255,255,0.3)' : 'none' }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Revealed code on loss */}
          {status === 'lost' && (
            <div style={{ padding: '0 14px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 9, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 1 }}>CODE_WAS:</span>
              <div style={{ display: 'flex', gap: 5 }}>
                {secret.map((c, i) => {
                  const fill = pegFill(activePegType, activeValues[c]);
                  return (
                    <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...fill.style }}>
                      <PegLabel label={fill.label} size={8} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 2P result recap — both timers, once the round's over */}
          {mode === '2p' && gameOver && (
            <div style={{ padding: '0 14px 10px', fontSize: 9, color: SIM.txMuted, fontFamily: SIM.font, letterSpacing: 0.5 }}>
              P1 setup: {formatTime(setupElapsed)} · P2 guess: {formatTime(guessElapsed)}
            </div>
          )}

          {/* Peg picker */}
          <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${activeValues.length},1fr)`, gap: 6, flex: 1, maxWidth: activeValues.length * 44 }}>
              {activeValues.map((p, idx) => {
                const fill = pegFill(activePegType, p);
                return (
                  <button
                    key={p.key}
                    className="mm-peg-btn"
                    disabled={gameOver || current.length >= CODE_LENGTH}
                    onClick={() => placePeg(idx)}
                    title={activePegType === 'number' ? String(p.num) : PEGS[idx % PEGS.length].key}
                    style={fill.style}
                  >
                    <PegLabel label={fill.label} size={13} />
                  </button>
                );
              })}
            </div>
            <button
              onClick={undoPeg}
              disabled={gameOver || !current.length}
              className="sim-icon-btn"
              style={{ ...simIconBtn(false), opacity: gameOver || !current.length ? 0.35 : 1 }}
              title="Remove last peg"
            >
              <Eraser size={13} />
            </button>
          </div>

          {/* 2P: guess must be explicitly locked in before it scores */}
          {mode === '2p' && (
            <div style={{ padding: '0 14px 12px' }}>
              <button
                onClick={submitGuess}
                disabled={!awaitingLock}
                style={{
                  width: '100%', padding: '10px', borderRadius: 3,
                  cursor: awaitingLock ? 'pointer' : 'default',
                  background: awaitingLock ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${awaitingLock ? SIM.purple : 'rgba(255,255,255,0.1)'}`,
                  color: awaitingLock ? SIM.purple : SIM.txMuted,
                  fontFamily: SIM.font, fontSize: 10, fontWeight: 900, letterSpacing: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  transition: 'all 0.15s',
                }}
              >
                <Lock size={12} /> LOCK GUESS
              </button>
            </div>
          )}
        </>
      )}

      {/* Footer */}
      <div style={simFooter}>
        <span style={simStatus(isActive)}>
          {isActive ? '▶ CONTROLS_ENGAGED' : '◼ SYSTEM_STANDBY'}
        </span>
        <button
          onClick={resetStats}
          className="sim-icon-btn"
          style={{ ...simIconBtn(false), fontSize: 8, fontFamily: SIM.font, gap: 4, letterSpacing: 0.5 }}
        >
          RESET STATS
        </button>
      </div>
    </div>
    </>
  );
}
