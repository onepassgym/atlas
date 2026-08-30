import { MapPin, Globe2, Clock, Rocket, Eye, Tag } from 'lucide-react';

function timeAgo(date) {
  if (!date) return 'Never';
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ChainCard({ chain, onCrawl, onViewSpaces, onTag }) {
  return (
    <div className="card" style={{ padding: 18, cursor: 'default' }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{chain.name}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        {chain.headquarters || ''}
        {chain.foundedYear ? ` • Est. ${chain.foundedYear}` : ''}
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <MapPin size={12} /> <strong style={{ color: 'var(--text-primary)' }}>{(chain.totalLocations || 0).toLocaleString()}</strong> locations
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Globe2 size={12} /> <strong style={{ color: 'var(--text-primary)' }}>{(chain.countriesPresent || []).length}</strong> countries
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Clock size={12} /> Last: <strong style={{ color: 'var(--text-primary)' }}>{timeAgo(chain.lastCrawledAt)}</strong>
        </span>
        <span className={`freq-badge ${chain.crawlFrequency}`}>{chain.crawlFrequency}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn sm primary" onClick={() => onCrawl?.(chain.slug, chain.name)}>
          <Rocket size={12} /> Crawl
        </button>
        <button className="btn sm" onClick={() => onViewSpaces?.(chain.slug, chain.name)}>
          <Eye size={12} /> Locations
        </button>
        <button className="btn sm" onClick={() => onTag?.(chain.slug)}>
          <Tag size={12} /> Tag
        </button>
      </div>
    </div>
  );
}
