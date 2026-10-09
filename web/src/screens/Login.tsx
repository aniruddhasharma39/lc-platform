import React, { useState, useEffect } from 'react';
import type { User } from '../types';
import { API_URL } from '../config';

type Props = {
  onLogin: (user: User, token: string) => void;
  onGoToRegister: () => void;
};

export default function Login({ onLogin, onGoToRegister }: Props) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [branding, setBranding] = useState({ appName: 'LC Platform', wallpaperUrl: '' });

  useEffect(() => {
    fetch(`${API_URL}/api/v1/settings/branding`)
      .then(res => res.json())
      .then(data => setBranding(data))
      .catch(err => console.error(err));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }

      onLogin(data.user, data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center w-full" style={{ 
      minHeight: '100vh', 
      backgroundImage: branding.wallpaperUrl ? `url(${branding.wallpaperUrl})` : 'none',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: '400px', backgroundColor: 'rgba(255,255,255,0.95)', backdropFilter: 'blur(10px)' }}>
        <h2 className="text-center" style={{ color: 'var(--primary)', marginBottom: '1.5rem' }}>Login to {branding.appName}</h2>
        
        {error && (
          <div className="card mb-4" style={{ backgroundColor: 'rgba(214, 69, 69, 0.1)', borderColor: 'var(--danger)', color: 'var(--danger)', padding: '0.75rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex-col gap-4">
          <div>
            <label className="text-sm text-muted">Mobile, Email or Employee ID</label>
            <input 
              type="text" 
              value={identifier} 
              onChange={e => setIdentifier(e.target.value)} 
              required 
            />
          </div>
          <div>
            <label className="text-sm text-muted">Password</label>
            <div style={{ position: 'relative' }}>
              <input 
                type={showPassword ? "text" : "password"} 
                value={password} 
                onChange={e => setPassword(e.target.value)} 
                required 
              />
              <button 
                type="button" 
                onClick={() => setShowPassword(!showPassword)}
                style={{ position: 'absolute', right: '0.5rem', top: '0.5rem', background: 'none', border: 'none', padding: 0, color: 'var(--secondary)' }}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          
          <button type="submit" className="primary w-full mt-4" disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>

        <div className="text-center mt-4">
          <span className="text-muted text-sm">New user? </span>
          <button className="outline" style={{ border: 'none', color: 'var(--secondary)', padding: 0 }} onClick={onGoToRegister}>
            Register
          </button>
        </div>
      </div>
    </div>
  );
}
