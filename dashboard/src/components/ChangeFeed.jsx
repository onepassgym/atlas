import { motion } from 'framer-motion';
import { AlertTriangle, TrendingDown, TrendingUp, XCircle, CheckCircle, ArrowRight } from 'lucide-react';

const SEVERITY_STYLES = {
  danger:  { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.25)', color: '#ef4444', icon: XCircle },
  warning: { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.25)', color: '#f59e0b', icon: AlertTriangle },
  success: { bg: 'rgba(16,185,129,0.10)', border: 'rgba(16,185,129,0.25)', color: '#10b981', icon: CheckCircle },
  info:    { bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.25)', color: '#3b82f6', icon: ArrowRight },
};

export default function ChangeFeed({ changes = [], loading = false }) {
  if (loading) return <div className="empty-state">Loading changes…</div>;
  if (!changes.length) return <div className="empty-state"><div className="empty-state-icon">📭</div><div>No significant changes detected</div></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {changes.map((c, i) => {
        const s = SEVERITY_STYLES[c.severity] || SEVERITY_STYLES.info;
        const Icon = s.icon;
        const spaceName = c.spaceId?.name || 'Unknown Space';
        const area = c.spaceId?.areaName || '';
        return (
          <motion.div
            key={c._id || i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03 }}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              borderRadius: 8, background: s.bg, border: `1px solid ${s.border}`, marginBottom: 4,
            }}
          >
            <Icon size={15} style={{ color: s.color, flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>{spaceName}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                  {new Date(c.changedAt).toLocaleDateString()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: s.color, fontWeight: 600, marginTop: 2 }}>{c.label}</div>
              {area && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{area}</div>}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
