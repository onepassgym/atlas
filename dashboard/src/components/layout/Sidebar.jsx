import { NavLink } from 'react-router-dom';
import {
  LayoutGrid, Target, Database, Zap,
  Activity, ImageIcon, Radio,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/overview',    icon: LayoutGrid, label: 'Overview'    },
  { to: '/scrape',      icon: Target,     label: 'Scrape'      },
  { to: '/explorer',    icon: Database,   label: 'Explorer'    },
  { to: '/enrichment',  icon: Zap,        label: 'Enrichment'  },
  { to: '/data-health', icon: Activity,   label: 'Data Health' },
  { to: '/media',       icon: ImageIcon,  label: 'Media'       },
  { to: '/sources',     icon: Radio,      label: 'Sources'     },
];

export default function Sidebar() {
  return (
    <nav style={{
      width: 'var(--sidebar-w, 52px)',
      flexShrink: 0,
      background: '#000',
      borderRight: '1px solid #1A1A1A',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 8,
      paddingBottom: 8,
      gap: 2,
    }}>
      {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          title={label}
          style={({ isActive }) => ({
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isActive ? '#A78BFA' : '#52525B',
            background: isActive ? 'rgba(124,58,237,0.15)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            transition: 'all 0.15s',
            textDecoration: 'none',
          })}
          onMouseEnter={e => {
            if (!e.currentTarget.getAttribute('aria-current')) {
              e.currentTarget.style.background = '#1A1A1A';
              e.currentTarget.style.color = '#A1A1AA';
            }
          }}
          onMouseLeave={e => {
            const isActive = e.currentTarget.getAttribute('aria-current') === 'page';
            e.currentTarget.style.background = isActive ? 'rgba(124,58,237,0.15)' : 'transparent';
            e.currentTarget.style.color = isActive ? '#A78BFA' : '#52525B';
          }}
        >
          <Icon size={18} strokeWidth={1.75} />
        </NavLink>
      ))}

      <style>{`
        nav a[aria-current="page"] {
          background: rgba(124,58,237,0.15) !important;
          color: #A78BFA !important;
        }
        nav a:hover {
          background: #1A1A1A !important;
          color: #A1A1AA !important;
        }
        nav a[aria-current="page"]:hover {
          background: rgba(124,58,237,0.2) !important;
          color: #A78BFA !important;
        }
      `}</style>
    </nav>
  );
}
