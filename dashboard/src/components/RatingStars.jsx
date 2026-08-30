import React from 'react';
import { Star } from 'lucide-react';

export default function RatingStars({ rating }) {
  if (!rating) return <span className="gym-row-metric dim">—</span>;
  const full = Math.floor(rating);
  const hasHalf = rating % 1 >= 0.3;
  return (
    <span className="gym-row-stars" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star 
          key={i} 
          size={12} 
          fill={i < full ? '#f59e0b' : (i === full && hasHalf ? '#f59e0b' : 'none')}
          stroke={i < full || (i === full && hasHalf) ? '#f59e0b' : 'rgba(100,116,139,0.4)'}
          style={i === full && hasHalf ? { clipPath: 'inset(0 50% 0 0)' } : {}}
        />
      ))}
      <span className="gym-row-rating-num" style={{ marginLeft: 4, fontWeight: 600 }}>{rating.toFixed(1)}</span>
    </span>
  );
}
