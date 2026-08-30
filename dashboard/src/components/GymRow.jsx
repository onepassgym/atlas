import React from 'react';
import { Star, MessageCircle, Target, MapPin, Phone, Globe, ImageIcon, Award } from 'lucide-react';
import { getProxyUrl } from '../api/client';
import RatingStars from './RatingStars';

function formatCategory(cat) {
  if (!cat || cat === 'undefined' || cat === 'unknown') return null;
  return String(cat).split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function HighlightText({ text, search }) {
  if (!search || !text) return <>{text}</>;
  
  const searchStr = String(search).trim().toLowerCase();
  const textStr = String(text);
  
  if (!searchStr) return <>{text}</>;
  
  // Try exact substring match first (more accurate highlighting)
  const lowerText = textStr.toLowerCase();
  const matchIndex = lowerText.indexOf(searchStr);
  
  if (matchIndex !== -1) {
    return (
      <>
        {textStr.slice(0, matchIndex)}
        <span className="highlight-match">{textStr.slice(matchIndex, matchIndex + searchStr.length)}</span>
        {textStr.slice(matchIndex + searchStr.length)}
      </>
    );
  }
  
  // Fallback: word-level matching for multi-word queries
  const words = searchStr.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 1) {
    let result = textStr;
    for (const word of words) {
      const regex = new RegExp(`(${word.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')})`, 'gi');
      result = result.replace(regex, '‹HL›$1‹/HL›');
    }
    if (result !== textStr) {
      const parts = result.split(/(‹HL›.*?‹\/HL›)/);
      return (
        <>
          {parts.map((part, i) => {
            if (part.startsWith('‹HL›')) {
              return <span key={i} className="highlight-match">{part.replace(/‹\/?HL›/g, '')}</span>;
            }
            return part;
          })}
        </>
      );
    }
  }

  // Final fallback: fuzzy character matching
  const searchChars = searchStr.replace(/\s+/g, '').split('');
  if (searchChars.length === 0) return <>{text}</>;

  let searchIndex = 0;
  const resultParts = [];

  for (let i = 0; i < textStr.length; i++) {
    const char = textStr[i];
    if (searchIndex < searchChars.length && char.toLowerCase() === searchChars[searchIndex]) {
      resultParts.push(<span key={i} className="highlight-match-fuzzy">{char}</span>);
      searchIndex++;
    } else {
      resultParts.push(char);
    }
  }
  return <>{resultParts}</>;
}

function QualityBadge({ score }) {
  if (!score && score !== 0) return null;
  let color, bg, label;
  if (score >= 80) { color = '#10b981'; bg = 'rgba(16,185,129,0.12)'; label = 'Excellent'; }
  else if (score >= 60) { color = '#3b82f6'; bg = 'rgba(59,130,246,0.12)'; label = 'Good'; }
  else if (score >= 40) { color = '#f59e0b'; bg = 'rgba(245,158,11,0.12)'; label = 'Average'; }
  else { color = '#ef4444'; bg = 'rgba(239,68,68,0.12)'; label = 'Low'; }
  
  return (
    <span className="gym-row-quality" style={{ color, background: bg, borderColor: `${color}33` }}>
      <Award size={10} /> {score}
    </span>
  );
}

// RatingStars imported from ./RatingStars

export default React.memo(function GymRow({ gym, onClick, searchTerm = '' }) {
  const categoryLabel = formatCategory(gym.category) || (gym.categoryId?.label ? formatCategory(gym.categoryId.label) : null);

  return (
    <div className="gym-row-card" onClick={() => onClick?.(gym._id)} id={`gym-${gym._id}`}>
      {/* Thumbnail */}
      <div className="gym-row-thumb">
        {gym.coverPhoto?.thumbnailUrl || gym.coverPhoto?.publicUrl || typeof gym.coverPhoto === 'string' ? (
          <img 
            src={getProxyUrl(gym.coverPhoto?.thumbnailUrl || gym.coverPhoto?.publicUrl || gym.coverPhoto)} 
            alt="" 
            loading="lazy"
            onError={(e) => {
              e.target.style.display = 'none';
              e.target.nextElementSibling.style.display = 'flex';
            }}
          />
        ) : null}
        <div className="gym-row-thumb-fallback" style={{ display: (gym.coverPhoto?.thumbnailUrl || gym.coverPhoto?.publicUrl || typeof gym.coverPhoto === 'string') ? 'none' : 'flex' }}>
          <MapPin size={18} />
        </div>
      </div>

      {/* Main Content */}
      <div className="gym-row-content">
        <div className="gym-row-title">
          <HighlightText text={gym.name} search={searchTerm} />
          {gym.isChainMember && gym.chainName && (
            <span className="gym-row-chain-badge">
              🔗 <HighlightText text={gym.chainName} search={searchTerm} />
            </span>
          )}
        </div>
        <div className="gym-row-subtitle">
          <span className="gym-row-location">
            <MapPin size={11} />
            <HighlightText text={gym.areaName || gym.address || '—'} search={searchTerm} />
          </span>
          {categoryLabel && (
            <span className="gym-row-category">{categoryLabel}</span>
          )}
          {gym.contact?.phone && (
            <span className="gym-row-contact"><Phone size={10} /> {gym.contact.phone}</span>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="gym-row-metrics">
        <RatingStars rating={gym.rating} />
        <span className="gym-row-metric">
          <MessageCircle size={11} />
          <span>{(gym.totalReviews || 0).toLocaleString()}</span>
        </span>
        {gym.totalPhotos > 0 && (
          <span className="gym-row-metric dim">
            <ImageIcon size={11} />
            <span>{gym.totalPhotos}</span>
          </span>
        )}
        <QualityBadge score={gym.qualityScore} />
      </div>
    </div>
  );
});
