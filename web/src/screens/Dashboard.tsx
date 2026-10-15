import { useEffect, useState } from 'react';
import { 
  FaBell, FaBars, FaTimes, FaUser, FaUserCircle, 
  FaUserPlus, FaNetworkWired, FaMicrochip, FaCheckCircle, 
  FaLock, FaSearchPlus,
  FaHome, FaLayerGroup, FaUsers, FaShieldAlt, FaPaintBrush, 
  FaFileAlt, FaChartBar, FaHistory, FaVideo, FaTrain, FaCog, 
  FaMapMarkerAlt, FaDatabase, FaArchway
} from 'react-icons/fa';
import type { User, NotificationItem } from '../types';
import Roles from './Roles';
import RegistrationBuilder from './RegistrationBuilder';
import Branding from './Branding';
import ClusterDashboard from './Cluster/ClusterDashboard';
import ManageUsers from './ManageUsers';
import ScopeGroupManagement from './ScopeGroups/ScopeGroupManagement';
import LCGatesScreen from './LCGates/LCGatesScreen';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';

type Props = {
  user: User;
  onLogout: () => void;
};

const CANONICAL_MODULE_ORDER = [
  'lc-gates',
  'cluster',
  'scope-groups',
  'manage-users',
  'registration',
  'roles',
  'branding',
];

const DEFAULT_SYSTEM_MODULES = [
  { name: 'LC Gates', slug: 'lc-gates' },
  { name: 'Cluster', slug: 'cluster' },
  { name: 'Scope Groups', slug: 'scope-groups' },
  { name: 'Manage Users', slug: 'manage-users' },
  { name: 'Registration Builder', slug: 'registration' },
  { name: 'Roles', slug: 'roles' },
  { name: 'Branding', slug: 'branding' },
];

const sortModules = (modules: any[]) => {
  return [...modules].sort((a, b) => {
    const slugA = (a.slug || '').toLowerCase();
    const slugB = (b.slug || '').toLowerCase();
    let idxA = CANONICAL_MODULE_ORDER.indexOf(slugA);
    let idxB = CANONICAL_MODULE_ORDER.indexOf(slugB);
    if (idxA === -1) idxA = 999;
    if (idxB === -1) idxB = 999;
    if (idxA !== idxB) return idxA - idxB;
    return (a.name || '').localeCompare(b.name || '');
  });
};

const getSidebarModuleIcon = (name: string, slug?: string) => {
  const key = (slug || name).toLowerCase();
  if (key.includes('lc-gate') || key.includes('lc gate') || key === 'lc-gates') return FaArchway;
  if (key.includes('scope') || key.includes('group')) return FaLayerGroup;
  if (key.includes('cluster') || key.includes('gate') || key.includes('device') || key.includes('barrier')) return FaMicrochip;
  if (key.includes('user') || key.includes('member') || key.includes('staff')) return FaUsers;
  if (key.includes('role') || key.includes('permission') || key.includes('access')) return FaShieldAlt;
  if (key.includes('brand') || key.includes('theme') || key.includes('logo')) return FaPaintBrush;
  if (key.includes('regis') || key.includes('form') || key.includes('builder')) return FaFileAlt;
  if (key.includes('chart') || key.includes('report') || key.includes('analytic')) return FaChartBar;
  if (key.includes('log') || key.includes('audit') || key.includes('history')) return FaHistory;
  if (key.includes('cctv') || key.includes('camera') || key.includes('video')) return FaVideo;
  if (key.includes('train') || key.includes('rail') || key.includes('track')) return FaTrain;
  if (key.includes('setting') || key.includes('config')) return FaCog;
  if (key.includes('map') || key.includes('location') || key.includes('gps')) return FaMapMarkerAlt;
  if (key.includes('data') || key.includes('database')) return FaDatabase;
  return FaLayerGroup;
};

export default function Dashboard({ user, onLogout }: Props) {
  const { success: toastSuccess, info: toastInfo } = useToast();
  const [currentView, setCurrentView] = useState<string>('home');
  const [systemModules, setSystemModules] = useState<any[]>(DEFAULT_SYSTEM_MODULES);
  const [branding, setBranding] = useState({ appName: 'LC Platform' });
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lc_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleSidebar = () => {
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setIsMobileMenuOpen(prev => !prev);
    } else {
      setIsSidebarCollapsed(prev => {
        const next = !prev;
        try {
          localStorage.setItem('lc_sidebar_collapsed', String(next));
        } catch {}
        return next;
      });
    }
  };

  // Notifications State
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);

  // Profile Modal State
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileData, setProfileData] = useState<User | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);

  const fetchSystemModules = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/modules`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setSystemModules(sortModules(data));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchBranding = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/settings/branding`);
      const data = await res.json();
      if(data && data.appName) setBranding(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchNotifications = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/notifications`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const markAllNotificationsAsRead = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    setUnreadCount(0);
    toastSuccess('All notifications marked as read.', 'Notifications');
    try {
      await fetch(`${API_URL}/api/v1/notifications/read-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ notificationIds: notifications.map(n => n.id) })
      });
    } catch (err) {
      console.error(err);
    }
  };

  const clearAllNotifications = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setNotifications([]);
    setUnreadCount(0);
    toastInfo('Notification tray cleared.', 'Notifications');
    try {
      await fetch(`${API_URL}/api/v1/notifications/clear-all`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
    } catch (err) {
      console.error(err);
    }
  };

  const dismissNotification = async (id: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setNotifications(prev => {
      const filtered = prev.filter(n => n.id !== id);
      setUnreadCount(filtered.filter(n => !n.isRead).length);
      return filtered;
    });
    toastInfo('Notification removed from tray.', 'Notifications');
    try {
      await fetch(`${API_URL}/api/v1/notifications/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleNotificationClick = async (item: NotificationItem) => {
    if (!item.isRead) {
      fetch(`${API_URL}/api/v1/notifications/${item.id}/read`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      }).catch(console.error);
      setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, isRead: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    }
    if (item.targetModule) {
      setCurrentView(item.targetModule);
    }
    setIsNotificationsOpen(false);
  };

  const fetchUserProfile = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setProfileData(data);
      } else {
        setProfileData(user);
      }
    } catch (err) {
      setProfileData(user);
    }
  };

  const humanizeKey = (key: string) => {
    const cleanKey = key.trim();
    const normalized = cleanKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'fullname' || normalized === 'name' || normalized === 'applicantname') return 'Full Name';
    if (normalized === 'mobile' || normalized === 'phone' || normalized === 'mobilenumber' || normalized === 'phonenumber') return 'Mobile Number';
    if (normalized === 'email' || normalized === 'emailaddress') return 'Email Address';
    if (normalized === 'employeeid' || normalized === 'empid') return 'Employee ID';
    if (normalized === 'department' || normalized === 'dept') return 'Department';
    if (normalized === 'gender') return 'Gender';
    if (cleanKey.startsWith('field_')) {
      const sub = cleanKey.substring(6);
      return sub.length > 6 ? `Custom Field (${sub.substring(sub.length - 4)})` : `Custom Field (${sub})`;
    }
    return cleanKey
      .replace(/_/g, ' ')
      .replace(/([A-Z]+)/g, ' $1')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b[a-z]/g, str => str.toUpperCase());
  };

  const isImgUrl = (val: any) => {
    if (typeof val !== 'string') return false;
    const lower = val.toLowerCase().trim();
    return (
      (lower.startsWith('http://') || lower.startsWith('https://')) &&
      (
        lower.includes('/image/upload/') ||
        lower.includes('cloudinary') ||
        lower.includes('res.cloudinary') ||
        lower.endsWith('.png') ||
        lower.endsWith('.jpg') ||
        lower.endsWith('.jpeg') ||
        lower.endsWith('.webp') ||
        lower.endsWith('.gif') ||
        lower.endsWith('.svg')
      )
    );
  };

  useEffect(() => {
    // Fetch in parallel in background without blocking immediate UI rendering
    fetchSystemModules();
    fetchBranding();
    fetchNotifications();
    fetchUserProfile();

    // Poll notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app-container">
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff', borderBottom: '1px solid var(--border)', padding: '0.75rem 1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button 
            type="button" 
            className="sidebar-toggle-btn"
            onClick={handleToggleSidebar}
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <FaBars />
          </button>
          <h2 style={{ margin: 0, color: 'var(--primary)', fontSize: '1.25rem' }}>
            {branding.appName}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Notification Bell */}
          <div style={{ position: 'relative' }}>
            <button 
              type="button" 
              style={{ 
                position: 'relative', 
                background: isNotificationsOpen ? '#e0f2fe' : '#f8fafc',
                border: isNotificationsOpen ? '1.5px solid #0284c7' : '1px solid #cbd5e1',
                borderRadius: '50%',
                width: '42px',
                height: '42px',
                minWidth: '42px',
                minHeight: '42px',
                padding: 0,
                margin: 0,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: isNotificationsOpen ? '0 0 0 3px rgba(2, 132, 199, 0.15)' : '0 1px 3px rgba(0,0,0,0.06)',
              }}
              onClick={() => setIsNotificationsOpen(!isNotificationsOpen)}
              title="Notifications"
            >
              <FaBell size={19} style={{ color: isNotificationsOpen ? '#0284c7' : '#475569', display: 'block' }} />
              {unreadCount > 0 && (
                <span style={{
                  position: 'absolute',
                  top: '-3px',
                  right: '-3px',
                  backgroundColor: '#ef4444',
                  color: '#ffffff',
                  borderRadius: '9999px',
                  minWidth: '18px',
                  height: '18px',
                  padding: '0 4px',
                  fontSize: '0.68rem',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '2px solid #ffffff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  lineHeight: 1,
                  pointerEvents: 'none',
                }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notification Dropdown Popover */}
            {isNotificationsOpen && (
              <div 
                className="card"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  right: 0,
                  width: 380,
                  maxWidth: '92vw',
                  maxHeight: '480px',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 0,
                  zIndex: 1001,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  backgroundColor: '#fff',
                  overflow: 'hidden',
                }}
              >
                <div style={{
                  padding: '12px 16px',
                  backgroundColor: 'var(--surface)',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 'bold', fontSize: '0.95rem', color: 'var(--primary)' }}>Notifications</span>
                    {unreadCount > 0 && (
                      <span className="badge" style={{ backgroundColor: 'var(--primary)', color: 'white', fontSize: '0.72rem' }}>
                        {unreadCount} new
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {notifications.length > 0 && (
                      <>
                        <button 
                          type="button" 
                          style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: '2px 4px' }}
                          onClick={markAllNotificationsAsRead}
                          title="Mark all as read"
                        >
                          Mark read
                        </button>
                        <button 
                          type="button" 
                          style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: '2px 4px' }}
                          onClick={clearAllNotifications}
                          title="Clear all notifications"
                        >
                          Clear all
                        </button>
                      </>
                    )}
                    <button 
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: '0.85rem', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center' }}
                      onClick={() => setIsNotificationsOpen(false)}
                      title="Close"
                    >
                      <FaTimes />
                    </button>
                  </div>
                </div>

                <div style={{ overflowY: 'auto', maxHeight: '400px', display: 'flex', flexDirection: 'column' }}>
                  {notifications.length === 0 ? (
                    <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: '0.88rem' }}>
                      <FaCheckCircle size={32} style={{ color: '#10b981', marginBottom: 8 }} />
                      <div>No notifications right now.</div>
                    </div>
                  ) : (
                    notifications.map(item => (
                      <div 
                        key={item.id}
                        onClick={() => handleNotificationClick(item)}
                        style={{
                          padding: '12px 14px',
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: item.isRead ? '#ffffff' : '#f0f9ff',
                          borderLeft: item.isRead ? '4px solid transparent' : '4px solid #0284c7',
                          display: 'flex',
                          gap: 12,
                          alignItems: 'flex-start',
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                          position: 'relative'
                        }}
                      >
                        <div style={{ 
                          width: 32, 
                          height: 32, 
                          borderRadius: '50%', 
                          backgroundColor: item.type === 'user_request' ? '#e0f2fe' : item.type === 'cluster_created' ? '#ecfdf5' : '#fef3c7',
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center',
                          flexShrink: 0,
                          marginTop: 2
                        }}>
                          {item.type === 'user_request' ? (
                            <FaUserPlus style={{ color: '#0284c7', fontSize: '0.95rem' }} />
                          ) : item.type === 'cluster_created' ? (
                            <FaNetworkWired style={{ color: '#10b981', fontSize: '0.95rem' }} />
                          ) : (
                            <FaMicrochip style={{ color: '#d97706', fontSize: '0.95rem' }} />
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <strong style={{ fontSize: '0.85rem', color: item.isRead ? '#475569' : '#0f172a', fontWeight: item.isRead ? 600 : 700 }}>
                                {item.title}
                              </strong>
                              {!item.isRead && (
                                <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#0284c7', display: 'inline-block' }} />
                              )}
                            </div>
                            <small style={{ fontSize: '0.72rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                              {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </small>
                          </div>
                          <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: item.isRead ? '#64748b' : '#334155', lineHeight: 1.35 }}>
                            {item.message}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => dismissNotification(item.id, e)}
                          title="Dismiss"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#94a3b8',
                            cursor: 'pointer',
                            padding: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '4px',
                            flexShrink: 0
                          }}
                        >
                          <FaTimes size={12} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User Avatar with Hover Dropdown */}
          <div 
            style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
            onMouseEnter={() => setIsDropdownOpen(true)}
            onMouseLeave={() => setIsDropdownOpen(false)}
          >
            <div className="avatar" style={{ margin: 0 }}>
              {user.fullName.substring(0, 2).toUpperCase()}
            </div>
            
            {isDropdownOpen && (
              <div className="card" style={{ 
                position: 'absolute', top: '100%', right: 0, marginTop: '0.5rem',
                minWidth: 230, padding: 14, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 10,
                boxShadow: '0 10px 25px rgba(0,0,0,0.12)', borderRadius: 10,
              }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '1.05rem', lineHeight: 1.2 }}>{user.fullName}</div>
                  <div className="text-sm text-muted" style={{ lineHeight: 1.2, marginTop: 4 }}>{user.role}</div>
                  {user.email && <div className="text-xs text-muted" style={{ marginTop: 2 }}>{user.email}</div>}
                </div>
                <hr style={{ margin: '4px 0', borderColor: 'var(--border)', borderStyle: 'solid' }} />
                <button
                  type="button"
                  className="outline w-full"
                  style={{ padding: '8px 12px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 600 }}
                  onClick={() => {
                    setIsDropdownOpen(false);
                    fetchUserProfile();
                    setShowProfileModal(true);
                  }}
                >
                  <FaUser /> Profile Details
                </button>
                <button 
                  className="danger w-full" 
                  style={{ padding: '8px 16px', fontWeight: 'bold', fontSize: '0.85rem' }}
                  onClick={(e) => { e.stopPropagation(); if(window.confirm('Are you sure you want to logout?')) onLogout(); }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Drawer Backdrop */}
      <div 
        className={`sidebar-backdrop ${isMobileMenuOpen ? 'active' : ''}`}
        onClick={() => setIsMobileMenuOpen(false)}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div 
          className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''} ${isMobileMenuOpen ? 'mobile-open' : ''}`} 
          style={{ height: '100%', overflowY: 'auto' }}
        >
          {/* Mobile-only drawer header */}
          <div className="mobile-drawer-header">
            <span style={{ fontWeight: 'bold', color: 'var(--primary)', fontSize: '1.1rem' }}>{branding.appName}</span>
            <button 
              type="button" 
              onClick={() => setIsMobileMenuOpen(false)} 
              aria-label="Close menu"
              className="drawer-close-btn"
              title="Close menu"
            >
              <FaTimes />
            </button>
          </div>

          <nav className="sidebar-nav">
            <a 
              href="#" 
              className={`nav-item ${currentView === 'home' ? 'active' : ''}`} 
              onClick={(e) => { e.preventDefault(); setCurrentView('home'); setIsMobileMenuOpen(false); }}
              title="Home"
            >
              <FaHome style={{ fontSize: '1.15rem', flexShrink: 0 }} />
              <span>Home</span>
            </a>
            
            {(() => {
              const isDev = user.role === 'Developer';
              const hasAssignedScopes = Boolean(user.scopeGroups && user.scopeGroups.length > 0);
              const modulesToShow = (systemModules.length > 0 ? systemModules : DEFAULT_SYSTEM_MODULES)
                .filter(m => {
                  if (isDev) return true;
                  if (m.slug === 'lc-gates' && hasAssignedScopes) return true;
                  return user.allowedModules && user.allowedModules.includes(m.slug);
                });
              return modulesToShow.map(mod => {
                const IconComp = getSidebarModuleIcon(mod.name, mod.slug);
                return (
                  <a 
                    key={mod.slug} 
                    href="#" 
                    className={`nav-item ${currentView === mod.slug ? 'active' : ''}`} 
                    onClick={(e) => { e.preventDefault(); setCurrentView(mod.slug); setIsMobileMenuOpen(false); }}
                    title={mod.name}
                  >
                    <IconComp style={{ fontSize: '1.15rem', flexShrink: 0 }} />
                    <span>{mod.name}</span>
                  </a>
                );
              });
            })()}
          </nav>
        </div>

      <div className="main-content" style={{ height: '100%', overflowY: 'auto', flex: 1 }}>
        <header className="header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1.5rem', backgroundColor: 'transparent' }}>
          <h3 style={{ margin: 0 }}>
            {currentView === 'home' ? 'Home' : systemModules.find(m => m.slug === currentView)?.name || 'Dashboard'}
          </h3>
        </header>

        <main className="content-area">
          {currentView === 'lc-gates' && <LCGatesScreen user={user} />}
          {currentView === 'roles' && <Roles user={user} />}
          {currentView === 'registration' && <RegistrationBuilder />}
          {currentView === 'branding' && <Branding user={user} />}
          {currentView === 'cluster' && <ClusterDashboard user={user} />}
          {currentView === 'scope-groups' && <ScopeGroupManagement user={user} />}
          {currentView === 'manage-users' && <ManageUsers user={user} onUserUpdate={fetchNotifications} />}

          {currentView === 'home' && (
            <div className="card text-center" style={{ padding: 64, marginTop: 32 }}>
              <h2 style={{ fontSize: '2rem', color: 'var(--primary)', marginBottom: 16 }}>Welcome to LC Platform</h2>
              <p className="text-muted" style={{ fontSize: '1.2rem' }}>You are logged in as <strong>{user.role}</strong>.</p>
            </div>
          )}

          {!['roles', 'registration', 'branding', 'cluster', 'scope-groups', 'manage-users', 'lc-gates', 'home'].includes(currentView) && (() => {
            const currentMod = systemModules.find(m => m.slug === currentView);
            const FallbackIcon = getSidebarModuleIcon(currentMod?.name || '', currentView);
            return (
              <div className="card text-center" style={{ padding: 48, marginTop: 32, maxWidth: 620, margin: '32px auto 0' }}>
                <div style={{ 
                  width: 64, height: 64, borderRadius: 16, 
                  background: 'linear-gradient(135deg, rgba(11, 60, 122, 0.1) 0%, rgba(14, 154, 167, 0.15) 100%)',
                  color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.8rem', marginBottom: 16
                }}>
                  <FallbackIcon />
                </div>
                <h3 style={{ fontSize: '1.4rem', color: 'var(--text-main)', marginBottom: 8, fontWeight: 700 }}>
                  {currentMod?.name || 'Custom Module'}
                </h3>
                <p className="text-muted" style={{ fontSize: '0.95rem', lineHeight: 1.5, marginBottom: 0, maxWidth: 460, margin: '0 auto' }}>
                  This module is enabled for your role. The dedicated feature interface is currently connected and ready for component deployment.
                </p>
              </div>
            );
          })()}
        </main>
      </div>

      {/* Profile Details Modal */}
      {showProfileModal && (
        <div 
          style={{ 
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
            backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', 
            display: 'flex', alignItems: 'center', justifyContent: 'center', 
            zIndex: 2000, padding: 16 
          }}
          onClick={() => setShowProfileModal(false)}
        >
          <div 
            className="card slide-up" 
            style={{ 
              width: '100%', maxWidth: 650, maxHeight: '90vh', overflowY: 'auto', 
              padding: 0, borderRadius: 16, boxShadow: '0 20px 45px rgba(0,0,0,0.2)',
              backgroundColor: '#fff'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ 
              padding: '18px 24px', borderBottom: '1px solid var(--border)', 
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
              backgroundColor: 'var(--surface)' 
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FaUserCircle size={22} style={{ color: 'var(--primary)' }} />
                <h3 style={{ margin: 0, color: 'var(--primary)', fontWeight: 800 }}>Profile Details</h3>
              </div>
              <button 
                className="icon-btn" 
                style={{ fontSize: '1.1rem', cursor: 'pointer', display: 'flex', alignItems: 'center' }} 
                onClick={() => setShowProfileModal(false)}
              >
                <FaTimes size={15} />
              </button>
            </div>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* User Hero Banner */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: 16, borderRadius: 12, backgroundColor: 'rgba(11,60,122,0.05)', border: '1px solid rgba(11,60,122,0.1)' }}>
                <div className="avatar" style={{ width: 56, height: 56, fontSize: '1.4rem', backgroundColor: 'var(--primary)', color: 'white' }}>
                  {(profileData?.fullName || user.fullName).substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <h4 style={{ margin: '0 0 4px', fontSize: '1.25rem', color: '#1e293b' }}>{profileData?.fullName || user.fullName}</h4>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="badge" style={{ backgroundColor: 'var(--secondary)', color: 'white', fontSize: '0.8rem' }}>
                      {profileData?.role || user.role}
                    </span>
                    <span className="badge success" style={{ fontSize: '0.8rem' }}>
                      {profileData?.status || 'APPROVED'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Account Details Card */}
              <div>
                <h4 style={{ margin: '0 0 12px', color: 'var(--primary)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                  Account Information
                </h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>FULL NAME</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{profileData?.fullName || user.fullName}</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>EMPLOYEE ID</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{profileData?.employeeId || 'N/A'}</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>DEPARTMENT</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{profileData?.department || 'N/A'}</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>MOBILE NUMBER</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{profileData?.mobile || 'N/A'}</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>EMAIL ADDRESS</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{profileData?.email || user.email}</strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>MEMBER SINCE</span>
                    <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>
                      {profileData?.createdAt ? new Date(profileData.createdAt).toLocaleDateString() : 'N/A'}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gridColumn: '1 / -1' }}>
                    <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 4 }}>ASSIGNED SCOPE GROUPS</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(profileData?.scopeGroups && profileData.scopeGroups.length > 0) ? (
                        profileData.scopeGroups.map((sg: any) => (
                          <span key={sg.id} className="badge" style={{ backgroundColor: sg.color || '#0B3C7A', color: 'white' }}>
                            {sg.name}
                          </span>
                        ))
                      ) : user.role === 'Developer' ? (
                        <span className="badge" style={{ backgroundColor: 'var(--primary)', color: 'white' }}>
                          Full Access (Developer Mode)
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.88rem', color: '#94a3b8' }}>No scope groups assigned</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Dynamic Registration Fields */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                <h4 style={{ margin: '0 0 12px', color: 'var(--secondary)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                  Registration Form Submissions
                </h4>
                {(() => {
                  try {
                    const rawMeta = profileData?.metadata || user.metadata || '{}';
                    const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
                    const coreExclude = [
                      'fullname', 'name', 'applicantname',
                      'mobile', 'mobilenumber', 'phone', 'phonenumber',
                      'email', 'emailaddress',
                      'employeeid', 'empid',
                      'department', 'dept',
                      'role', 'roleid', 'password', 'status', 'id'
                    ];
                    const seenLabels = new Set<string>();
                    const seenVals = new Set<string>();
                    const validEntries: [string, any][] = [];

                    for (const [k, v] of Object.entries(meta)) {
                      if (v === null || v === undefined || v === '') continue;
                      const normK = k.toLowerCase().replace(/[^a-z0-9]/g, '');
                      if (normK.includes('password') || coreExclude.includes(normK)) continue;

                      const label = humanizeKey(k);
                      const normL = label.toLowerCase().replace(/[^a-z0-9]/g, '');
                      if (coreExclude.includes(normL)) continue;

                      const strVal = String(v).trim().toLowerCase();
                      if (seenLabels.has(normL) || seenVals.has(strVal)) continue;

                      seenLabels.add(normL);
                      if (!isImgUrl(v)) seenVals.add(strVal);
                      validEntries.push([label, v]);
                    }

                    if (validEntries.length === 0) {
                      return <p className="text-muted text-sm">No additional custom registration fields registered.</p>;
                    }
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
                        {validEntries.map(([label, v]: [string, any]) => {
                          const isImg = isImgUrl(v);
                          return (
                            <div key={label} style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="text-muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>{label.toUpperCase()}</span>
                              {isImg ? (
                                <div
                                  style={{
                                    position: 'relative', width: 90, height: 70, borderRadius: 8,
                                    overflow: 'hidden', border: '1px solid var(--border)', marginTop: 4,
                                    cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
                                  }}
                                  onClick={() => setImagePreviewUrl(v)}
                                  title="Click to view full image"
                                >
                                  <img
                                    src={v}
                                    alt={label}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  />
                                  <div style={{
                                    position: 'absolute', bottom: 3, right: 3,
                                    backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 4,
                                    padding: 3, display: 'flex', alignItems: 'center', justifyContent: 'center'
                                  }}>
                                    <FaSearchPlus color="#fff" size={10} />
                                  </div>
                                </div>
                              ) : (
                                <strong style={{ fontSize: '0.95rem', color: '#1e293b' }}>{Array.isArray(v) ? v.join(', ') : String(v)}</strong>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  } catch {
                    return <p className="text-muted text-sm">No additional dynamic fields registered.</p>;
                  }
                })()}
              </div>

              <div style={{ padding: '10px 14px', backgroundColor: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd', fontSize: '0.82rem', color: '#0369a1', display: 'flex', alignItems: 'center' }}>
                <span><FaLock style={{ marginRight: 8, verticalAlign: -1 }} /> <strong>Read-Only Notice:</strong> This profile reflects your verified registration record. Contact your system administrator to request updates.</span>
              </div>
            </div>

            <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', backgroundColor: 'var(--surface)' }}>
              <button className="primary" onClick={() => setShowProfileModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Image Zoom Dialog */}
      {imagePreviewUrl && (
        <div 
          style={{ 
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
            backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 3000, 
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 
          }} 
          onClick={() => setImagePreviewUrl(null)}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
            <img src={imagePreviewUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }} />
            <button 
              style={{ 
                position: 'absolute', top: -35, right: 0, 
                background: 'none', border: 'none', color: '#fff', 
                fontSize: '1.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center' 
              }} 
              onClick={() => setImagePreviewUrl(null)}
            >
              <FaTimes size={20} />
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
