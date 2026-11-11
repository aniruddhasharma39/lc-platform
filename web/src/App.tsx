import { useState, useEffect } from 'react';
import Login from './screens/Login';
import Register from './screens/Register';
import Dashboard from './screens/Dashboard';
import type { User } from './types';
import { API_URL } from './config';
import { useToast } from './context/ToastContext';
import { lcGatesCacheService } from './services/lcGatesCacheService';
import { reportsCacheService } from './services/reportsCacheService';
import { clusterCacheService } from './services/clusterCacheService';

function isRenderWebLocked(): boolean {
  if (import.meta.env.VITE_LOCK_WEB === 'true') return true;
  if (typeof window === 'undefined') return false;
  return window.location.hostname.toLowerCase().endsWith('.onrender.com');
}

function App() {
  const isLocked = isRenderWebLocked();
  const [currentScreen, setCurrentScreen] = useState<'login' | 'register' | 'dashboard'>('login');
  const [user, setUser] = useState<User | null>(null);
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState<string | null>(null);
  const { success, info } = useToast();

  const purgeHomeDashboardCache = () => {
    try {
      lcGatesCacheService.clearAllUserCaches();
      reportsCacheService.clearAllUserCaches();
      clusterCacheService.clearAll();
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('home_dashboard_cache_')) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
  };

  useEffect(() => {
    if (isLocked) return;
    const onAuthExpired = (e: any) => {
      const msg = e.detail?.message || 'Your session has expired. Please log in again.';
      setSessionExpiredMsg(msg);
      purgeHomeDashboardCache();
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setUser(null);
      setCurrentScreen('login');
    };
    window.addEventListener('auth:expired', onAuthExpired);
    return () => window.removeEventListener('auth:expired', onAuthExpired);
  }, [isLocked]);

  useEffect(() => {
    if (isLocked) {
      purgeHomeDashboardCache();
      try {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      } catch {}
      return;
    }
    const token = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    if (token && storedUser) {
      try {
        const parsed = JSON.parse(storedUser);
        setUser(parsed);
        setCurrentScreen('dashboard');

        // Proactively verify token validity with backend
        fetch(`${API_URL}/api/v1/auth/me`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }).then(async (res) => {
          if (res.status === 401) {
            purgeHomeDashboardCache();
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            setUser(null);
            setCurrentScreen('login');
            setSessionExpiredMsg('Your session has expired. Please log in again.');
          } else if (res.ok) {
            const freshUser = await res.json();
            setUser(freshUser);
            localStorage.setItem('user', JSON.stringify(freshUser));
          }
        }).catch(() => {
          // In case of network hiccup, allow cached user to remain loaded
        });
      } catch (e) {
        purgeHomeDashboardCache();
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
        setCurrentScreen('login');
      }
    }
  }, [isLocked]);

  const handleLogin = (loggedInUser: User, token: string) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(loggedInUser));
    setSessionExpiredMsg(null);
    setUser(loggedInUser);
    setCurrentScreen('dashboard');
    const roleName = typeof loggedInUser.role === 'object' ? (loggedInUser.role as any)?.name : loggedInUser.role;
    success(`Welcome back, ${loggedInUser.fullName || 'User'}! Logged in as ${roleName || 'Member'}.`, 'Login Successful');
  };

  const handleLogout = () => {
    purgeHomeDashboardCache();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setSessionExpiredMsg(null);
    setUser(null);
    setCurrentScreen('login');
    info('You have been logged out of your account.', 'Signed Out');
  };

  if (isLocked) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
          padding: '24px',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 460,
            width: '100%',
            background: '#ffffff',
            borderRadius: 16,
            border: '1px solid #cbd5e1',
            boxShadow: '0 10px 30px rgba(15, 23, 42, 0.08)',
            padding: '32px 28px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'inline-block',
              padding: '6px 14px',
              borderRadius: 999,
              background: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              fontSize: '0.75rem',
              fontWeight: 800,
              letterSpacing: '0.5px',
              marginBottom: 16,
            }}
          >
            WEB PORTAL UNAVAILABLE
          </div>
          <h1 style={{ margin: '0 0 10px', fontSize: '1.35rem', fontWeight: 800, color: '#0f172a' }}>
            Service Disabled on Legacy Web Host
          </h1>
          <p style={{ margin: 0, fontSize: '0.92rem', color: '#475569', lineHeight: 1.55 }}>
            The LC Platform Web Portal has been temporarily disabled on this host. Please use the updated <strong>LC Platform Android Mobile App</strong> for live gate operations and monitoring.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {currentScreen === 'login' && (
        <Login 
          onLogin={handleLogin} 
          onGoToRegister={() => setCurrentScreen('register')} 
          sessionExpiredMsg={sessionExpiredMsg || undefined}
        />
      )}
      {currentScreen === 'register' && (
        <Register 
          onGoToLogin={() => setCurrentScreen('login')} 
        />
      )}
      {currentScreen === 'dashboard' && user && (
        <Dashboard 
          user={user} 
          onLogout={handleLogout} 
        />
      )}
    </div>
  );
}

export default App;
