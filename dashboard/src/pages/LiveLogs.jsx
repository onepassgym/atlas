import { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Terminal, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';

export default function LiveLogs() {
  const { logs, clearLogs } = useApp();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <motion.div className="container" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <div className="card" style={{ height: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 16, marginBottom: 16 }}>
          <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
            <div style={{ padding: 8, background: 'rgba(167, 139, 250, 0.1)', borderRadius: 8, border: '1px solid rgba(167, 139, 250, 0.2)' }}>
              <Terminal size={18} color="#a78bfa" />
            </div>
            Live System Logs
          </span>
          <button className="btn danger" onClick={clearLogs}>
            <Trash2 size={14} /> Clear Logs
          </button>
        </div>
        
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--mono)', fontSize: 13, background: '#0a0a0a', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)' }}>
          {logs.length === 0 ? (
            <div className="empty-state" style={{ height: '100%' }}>
              <div className="empty-state-icon" style={{ fontSize: 32, marginBottom: 8 }}>🪵</div>
              <div style={{ fontSize: 14 }}>Waiting for live log stream...</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>System events will appear here in real-time</div>
            </div>
          ) : logs.slice(0, 500).map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, lineHeight: 1.5, borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 70, flexShrink: 0 }}>{l.timestamp?.split(' ')[1] || ''}</span>
              <span style={{ fontWeight: 700, width: 50, flexShrink: 0, textTransform: 'uppercase', color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning)' : 'var(--success)' }}>{l.level || 'info'}</span>
              <span style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.message || ''}{l.stack ? '\n' + l.stack : ''}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </motion.div>
  );
}
