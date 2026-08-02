import React, { useState } from 'react';
import './ApiKeyModal.css';

export default function ApiKeyModal({ env, onSave }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!key.trim()) {
      setError('API key is required.');
      return;
    }
    onSave(key.trim());
  };

  return (
    <div className="api-key-modal-overlay">
      <div className="api-key-modal">
        <h2>Authentication Required</h2>
        <p>Please enter your atlas API Key for the <strong>{env.toUpperCase()}</strong> environment to continue.</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Enter API Key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
          {error && <div className="api-key-error">{error}</div>}
          <button type="submit">Connect</button>
        </form>
      </div>
    </div>
  );
}
