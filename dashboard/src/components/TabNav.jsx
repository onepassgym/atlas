import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Search, Link2, ClipboardList, Settings, Globe2, Zap, HeartPulse, Gamepad2, Image as ImageIcon, Target } from 'lucide-react';

// Feature flag: set to true to show Simulations tab
const FEATURE_GAME = false;

const tabs = [
  { to: '/overview',     icon: LayoutDashboard, label: 'Overview' },
  { to: '/scrape',       icon: Target,          label: 'Scrape' },
  { to: '/explorer',     icon: Search,          label: 'Space Explorer' },
  { to: '/data-health',  icon: HeartPulse,      label: 'Data Health' },
  { to: '/enrichment',   icon: Zap,             label: 'Enrichment' },
  { to: '/globe',        icon: Globe2,          label: 'Globe' },
  { to: '/media',        icon: ImageIcon,       label: 'Media' },
  ...(FEATURE_GAME ? [{ to: '/simulations', icon: Gamepad2, label: 'Simulations' }] : []),
];

export default function TabNav({ badges = {} }) {
  return (
    <nav className="tab-nav" id="tab-navigation">
      {tabs.map(({ to, icon: Icon, label, badgeId }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `tab-btn${isActive ? ' active' : ''}`}
        >
          <Icon size={18} className="tab-icon" />
          <span className="tab-label">{label}</span>
          {badgeId && badges[badgeId] != null && (
            <span className="tab-badge">{badges[badgeId]}</span>
          )}
        </NavLink>
      ))}
      <style>{`
        .tab-nav {
          position: sticky; top: 55px; z-index: 99;
          background: var(--bg-tab);
          backdrop-filter: blur(12px);
          border-bottom: 1px solid var(--border);
          display: flex; gap: 0; padding: 0 24px;
          overflow-x: auto; scrollbar-width: none;
          -webkit-overflow-scrolling: touch;
          transition: background 0.3s ease;
        }
        .tab-nav::-webkit-scrollbar { display: none; }
        .tab-btn {
          padding: 12px 20px; font-family: var(--font); font-size: 13px; font-weight: 600;
          color: var(--text-muted); cursor: pointer; border: none; background: none;
          border-bottom: 2px solid transparent; transition: all 0.2s;
          display: flex; align-items: center; gap: 6px; white-space: nowrap;
          text-decoration: none; position: relative;
        }
        .tab-btn:hover { color: var(--text-secondary); text-decoration: none; }
        .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
        .tab-badge {
          font-size: 10px; padding: 1px 6px; border-radius: 10px;
          background: rgba(59, 130, 246, 0.15); color: var(--accent);
          font-family: var(--mono);
        }
        @media (max-width: 768px) {
          .tab-nav { padding: 0 12px; }
          .tab-btn { padding: 12px 14px; font-size: 12px; }
        }
        @media (max-width: 640px) {
          .tab-nav { 
            position: fixed; 
            top: auto; 
            bottom: 0; 
            left: 0; 
            right: 0; 
            padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); 
            border-top: 1px solid var(--border); 
            border-bottom: none; 
            justify-content: flex-start; 
            background: var(--bg-header);
            box-shadow: 0 -4px 20px rgba(0,0,0,0.1);
            overflow-x: auto;
            flex-wrap: nowrap;
          }
          .tab-btn { 
            flex-direction: column; 
            padding: 6px 4px; 
            font-size: 9px; 
            gap: 4px; 
            border-bottom: none; 
            border-radius: 8px;
            flex: 0 0 72px; 
            text-align: center;
            justify-content: center;
          }
          .tab-btn.active { 
            border-bottom-color: transparent; 
            color: var(--accent); 
            background: rgba(139, 92, 246, 0.08);
          }
          .tab-icon { width: 20px; height: 20px; }
          .tab-label { font-size: 9px; font-weight: 700; }
          .tab-badge { position: absolute; top: 4px; right: 10%; font-size: 8px; padding: 0 4px; }
        }
      `}</style>
    </nav>
  );
}
