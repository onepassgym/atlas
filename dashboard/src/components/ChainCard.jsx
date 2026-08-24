import { MapPin, Globe2, Clock, Rocket, Eye, Tag } from 'lucide-react';

function timeAgo(date) {
  if (!date) return 'Never';
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ChainCard({ chain, onCrawl, onViewGyms, onTag }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'default' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{chain.name}</div>
          <span className={`freq-badge ${chain.crawlFrequency}`} style={{ fontSize: 10, padding: '2px 6px' }}>{chain.crawlFrequency}</span>
        </div>
        
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MapPin size={10} /> {(chain.totalLocations || 0).toLocaleString()} locs
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Globe2 size={10} /> {(chain.countriesPresent || []).length} regions
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={10} /> {timeAgo(chain.lastCrawledAt)}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" onClick={() => onCrawl?.(chain.slug, chain.name)} title="Execute Crawl">
          <Rocket size={12} /> Crawl
        </button>
        <button className="btn sm secondary" onClick={() => onViewGyms?.(chain.slug, chain.name)} title="View Nodes">
          <Eye size={12} /> Nodes
        </button>
        <button className="btn sm" onClick={() => onTag?.(chain.slug)} title="Tag Automatically">
          <Tag size={12} /> Tag
        </button>
      </div>
    </div>
  );
}
