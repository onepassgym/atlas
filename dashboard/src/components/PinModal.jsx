import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';
import './PinModal.css';

export default function PinModal({ onUnlock }) {
  const [pin, setPin] = useState(['', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputsRef = useRef([]);

  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  const handleChange = (e, index) => {
    const val = e.target.value.replace(/[^0-9]/g, '');
    if (!val) return;

    const newPin = [...pin];
    newPin[index] = val.substring(val.length - 1);
    setPin(newPin);
    setError('');

    if (index < 3) {
      inputsRef.current[index + 1]?.focus();
    } else {
      // Auto-submit when last digit is entered
      const fullPin = newPin.join('');
      if (fullPin.length === 4) {
        verifyPin(fullPin);
      }
    }
  };

  const handleKeyDown = (e, index) => {
    if (e.key === 'Backspace') {
      const newPin = [...pin];
      if (newPin[index] === '') {
        if (index > 0) {
          inputsRef.current[index - 1]?.focus();
          newPin[index - 1] = '';
        }
      } else {
        newPin[index] = '';
      }
      setPin(newPin);
      setError('');
    }
  };

  const verifyPin = async (fullPin) => {
    setLoading(true);
    try {
      const res = await api.post('/api/system/verify-pin', { pin: fullPin });
      if (res.success) {
        onUnlock();
      } else {
        setError(res.error || 'Invalid PIN');
        setPin(['', '', '', '']);
        inputsRef.current[0]?.focus();
      }
    } catch (e) {
      setError('Server Error. Try again.');
      setPin(['', '', '', '']);
      inputsRef.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content auth-modal">
        <div className="auth-header">
          <div className="auth-icon">🔒</div>
          <h2>Access Atlas</h2>
          <p>Please enter the 4-digit security code to proceed.</p>
        </div>
        
        <div className="pin-inputs">
          {pin.map((digit, i) => (
            <input
              key={i}
              ref={el => inputsRef.current[i] = el}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={digit}
              onChange={e => handleChange(e, i)}
              onKeyDown={e => handleKeyDown(e, i)}
              disabled={loading}
              className="pin-box"
              maxLength={2}
            />
          ))}
        </div>

        {error && <div className="auth-error">{error}</div>}
        
        <div className="auth-footer">
          <button 
            className="btn primary full-width"
            onClick={() => pin.join('').length === 4 && verifyPin(pin.join(''))}
            disabled={loading || pin.join('').length < 4}
          >
            {loading ? 'Verifying...' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}
