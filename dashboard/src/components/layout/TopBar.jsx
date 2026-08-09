import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { setApiKey, getApiKey } from '../../api/client';
import { KeyRound, X, Check } from 'lucide-react';

export default function TopBar() {
  const { connected } = useApp();
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput]         = useState('');
  const hasKey = !!getApiKey();

  const saveKey = () => {
    if (!keyInput.trim()) return;
    setApiKey(keyInput.trim());
    setKeyInput('');
    setShowKeyInput(false);
    window.location.reload();
  };

  return (
    <header style={{
      height: 'var(--topbar-h, 44px)',
      background: '#000',
      borderBottom: '1px solid #1A1A1A',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          fontSize: 15, fontWeight: 800, letterSpacing: '-0.5px',
          background: 'linear-gradient(120deg, #fff 30%, #A78BFA 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          ATLAS
        </span>
        <span style={{ width: 1, height: 16, background: '#2A2A2A' }} />
        <span style={{ fontSize: 11, color: '#52525B', fontFamily: 'var(--mono)', letterSpacing: '0.5px' }}>
          Fitness Intelligence
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {showKeyInput ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              autoFocus
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveKey(); if (e.key === 'Escape') setShowKeyInput(false); }}
              placeholder="Paste API key…"
              style={{
                background: '#111', border: '1px solid #7C3AED', borderRadius: 6,
                color: '#FAFAFA', fontSize: 12, padding: '4px 10px', width: 200, outline: 'none',
              }}
            />
            <button onClick={saveKey} style={btnStyle} title="Save"><Check size={12} style={{ color: '#10B981' }} /></button>
            <button onClick={() => setShowKeyInput(false)} style={btnStyle} title="Cancel"><X size={12} /></button>
          </div>
        ) : (
          <button
            onClick={() => setShowKeyInput(true)}
            title={hasKey ? 'API key set — click to change' : 'No API key — click to set'}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', border: `1px solid ${hasKey ? '#222' : '#7C3AED'}`,
              borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
              color: hasKey ? '#52525B' : '#A78BFA', fontSize: 11,
            }}
          >
            <KeyRound size={11} />
            {hasKey ? 'Key set' : 'Set API key'}
          </button>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: connected ? '#10B981' : '#52525B' }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: connected ? '#10B981' : '#3F3F46',
            boxShadow: connected ? '0 0 6px #10B981' : 'none',
          }} />
          <span style={{ fontFamily: 'var(--mono)' }}>{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}

const btnStyle = {
  background: '#111', border: '1px solid #222', borderRadius: 6,
  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer', color: '#71717A',
};
