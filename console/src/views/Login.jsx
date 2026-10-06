import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

const Login = () => {
  const [email, setEmail] = useState('admin@lcplatform.com');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--color-surface)' }}>
      <form onSubmit={handleSubmit} style={{ padding: '2rem', background: 'white', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', gap: '1rem', width: '300px' }}>
        <h2 style={{ margin: 0, color: 'var(--color-primary)' }}>LC Platform</h2>
        {error && <div style={{ color: 'var(--color-danger)' }}>{error}</div>}
        <input 
          type="email" 
          value={email} 
          onChange={e => setEmail(e.target.value)} 
          placeholder="Email" 
          required 
          style={{ padding: '0.5rem' }} 
        />
        <input 
          type="password" 
          value={password} 
          onChange={e => setPassword(e.target.value)} 
          placeholder="Password" 
          required 
          style={{ padding: '0.5rem' }} 
        />
        <button type="submit" style={{ padding: '0.5rem', background: 'var(--color-secondary)', color: 'white', border: 'none', cursor: 'pointer' }}>Login</button>
      </form>
    </div>
  );
};

export default Login;
