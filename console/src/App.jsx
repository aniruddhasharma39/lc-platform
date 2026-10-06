import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import Login from './views/Login';
import Dashboard from './views/Dashboard';
import ClusterBuilder from './views/ClusterBuilder';
import ScopeGroupBuilder from './views/ScopeGroupBuilder';
import RoleMatrix from './views/RoleMatrix';
import Settings from './views/Settings';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import './styles/theme.css';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
};

const AppContent = () => {
  const { user, menus, logout } = useAuth();

  return (
    <>
      {user && (
        <nav style={{ padding: '1rem', background: 'var(--color-primary)', color: 'white', display: 'flex', justifyContent: 'space-between' }}>
          <ul style={{ display: 'flex', gap: '1rem', listStyle: 'none', margin: 0, padding: 0 }}>
            <li><Link to="/dashboard" style={{ color: 'white' }}>Dashboard</Link></li>
            {menus.map((menu, idx) => (
              <li key={idx}><Link to={menu.path} style={{ color: 'white' }}>{menu.label}</Link></li>
            ))}
            <li><Link to="/scopes" style={{ color: 'white' }}>Scope Groups</Link></li>
            <li><Link to="/settings" style={{ color: 'white' }}>Settings</Link></li>
          </ul>
          <button onClick={logout} style={{ background: 'var(--color-danger)', color: 'white', border: 'none', padding: '0.5rem' }}>Logout</button>
        </nav>
      )}
      
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/clusters" element={<ProtectedRoute><ClusterBuilder /></ProtectedRoute>} />
        <Route path="/scopes" element={<ProtectedRoute><ScopeGroupBuilder /></ProtectedRoute>} />
        <Route path="/roles" element={<ProtectedRoute><RoleMatrix /></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute><div>User Management Screen</div></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to={user ? "/dashboard" : "/login"} />} />
      </Routes>
    </>
  );
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppContent />
      </Router>
    </AuthProvider>
  );
}

export default App;
