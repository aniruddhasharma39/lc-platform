import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../utils/api';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [menus, setMenus] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadConfig = async () => {
    try {
      const res = await api.get('/api/v1/me/config');
      setUser(res.data.data.user);
      setPermissions(res.data.data.permissions);
      setMenus(res.data.data.menus);
    } catch (error) {
      console.error('Failed to load config', error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (localStorage.getItem('accessToken')) {
      loadConfig();
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/api/v1/auth/login', { email, password });
    localStorage.setItem('accessToken', res.data.data.accessToken);
    localStorage.setItem('refreshToken', res.data.data.refreshToken);
    await loadConfig();
  };

  const logout = async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch (e) {}
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setUser(null);
    setPermissions([]);
    setMenus([]);
  };

  return (
    <AuthContext.Provider value={{ user, permissions, menus, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
