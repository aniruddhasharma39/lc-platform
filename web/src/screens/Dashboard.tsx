import { useEffect, useState } from 'react';
import type { User } from '../types';
import Roles from './Roles';
import RegistrationBuilder from './RegistrationBuilder';
import Branding from './Branding';
import ClusterDashboard from './Cluster/ClusterDashboard';

type Props = {
  user: User;
  onLogout: () => void;
};

export default function Dashboard({ user, onLogout }: Props) {
  const [users, setUsers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<string>('home');
  const [systemModules, setSystemModules] = useState<any[]>([]);
  const [branding, setBranding] = useState({ appName: 'LC Platform' });
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const fetchUsers = async () => {
    if (user.role !== 'Developer') return;
    try {
      const res = await fetch('http://localhost:5001/api/v1/users', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setUsers(data.users || []);
      setPendingRequests(data.pendingRequests || []);
    } catch (err) {
      console.error(err);
    }
  };

  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [confirmModal, setConfirmModal] = useState<{ id: number, action: string, name: string } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const fetchRoles = async () => {
    try {
      const res = await fetch('http://localhost:5001/api/v1/roles', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setRoles(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSystemModules = async () => {
    try {
      const res = await fetch('http://localhost:5001/api/v1/modules', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        setSystemModules(data);
      } else {
        setSystemModules([]);
      }
    } catch (err) {
      console.error(err);
      setSystemModules([]);
    }
  };

  const fetchBranding = async () => {
    try {
      const res = await fetch('http://localhost:5001/api/v1/branding');
      const data = await res.json();
      if(data && data.appName) setBranding(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchRoles();
    fetchUsers();
    fetchSystemModules();
    fetchBranding();
  }, []);

  const getDisplayData = (req: any, reqData: any) => {
    let schema: any = null;
    try {
      if (req.form?.schema) schema = JSON.parse(req.form.schema);
    } catch {}

    const allFields: any[] = [];
    const walk = (fields: any[]) => {
      if(!fields) return;
      for (const f of fields) {
        if (f.type === 'section' && f.children) walk(f.children);
        else allFields.push(f);
      }
    };
    if (schema?.fields) walk(schema.fields);

    let fullName = reqData.fullName;
    const formattedData: Record<string, any> = {};

    for (const [k, v] of Object.entries(reqData)) {
      if (k === 'password') continue;
      const field = allFields.find(f => f.name === k);
      const label = field ? field.label : k;
      formattedData[label] = v;

      if (!fullName && field && (field.label.toLowerCase().includes('name'))) {
        fullName = v;
      }
    }

    return { fullName: fullName || 'Unknown User', formattedData };
  };

  const handleAction = async (id: number, action: string, body = {}, isRequest = false) => {
    try {
      const endpoint = isRequest 
        ? `http://localhost:5001/api/v1/users/request/${id}/${action}`
        : `http://localhost:5001/api/v1/users/${id}/${action}`;
      
      await fetch(endpoint, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(body)
      });
      fetchUsers();
      showToast('Action completed successfully!');
    } catch (err) {
      console.error(err);
    }
  };

  const usersByRole = users.reduce((acc, curr) => {
    if (curr.status === 'PENDING') return acc; // Just in case, shouldn't happen now
    const roleName = curr.role?.name || 'Unknown';
    if (!acc[roleName]) acc[roleName] = [];
    acc[roleName].push(curr);
    return acc;
  }, {} as Record<string, any[]>);

  const [activeTab, setActiveTab] = useState<'existing' | 'pending'>('existing');

  return (
    <div className="app-container">
      {toastMessage && (
        <div style={{ 
          position: 'fixed', top: 20, right: 20, 
          backgroundColor: 'var(--success)', color: 'white', 
          padding: '12px 24px', borderRadius: 8, 
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', 
          zIndex: 9999, fontWeight: 'bold',
          transition: 'all 0.3s ease-in-out'
        }}>
          {toastMessage}
        </div>
      )}
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff', borderBottom: '1px solid var(--border)', padding: '0.75rem 1.5rem' }}>
        <h2 style={{ margin: 0, color: 'var(--primary)' }}>
          {branding.appName}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
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
                minWidth: 220, padding: 16, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 12,
                boxShadow: '0 10px 25px rgba(0,0,0,0.1)'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontWeight: 'bold', fontSize: '1.1rem', lineHeight: 1.2 }}>{user.fullName}</div>
                  <div className="text-sm text-muted" style={{ lineHeight: 1.2, marginTop: 4 }}>{user.role}</div>
                </div>
                <hr style={{ margin: '4px 0', borderColor: 'var(--border)', borderStyle: 'solid' }} />
                <button 
                  className="danger w-full" 
                  style={{ padding: '8px 16px', fontWeight: 'bold' }}
                  onClick={(e) => { e.stopPropagation(); if(window.confirm('Are you sure you want to logout?')) onLogout(); }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div className="sidebar" style={{ height: '100%', overflowY: 'auto' }}>
        <nav className="sidebar-nav">
          <a href="#" className={`nav-item ${currentView === 'home' ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); setCurrentView('home'); }}>Home</a>
          
          {systemModules.filter(m => user.allowedModules?.includes(m.slug)).map(mod => (
            <a 
              key={mod.slug} 
              href="#" 
              className={`nav-item ${currentView === mod.slug ? 'active' : ''}`} 
              onClick={(e) => { e.preventDefault(); setCurrentView(mod.slug); }}
            >
              {mod.name}
            </a>
          ))}
        </nav>
      </div>

      <div className="main-content" style={{ height: '100%', overflowY: 'auto', flex: 1 }}>
        <header className="header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem', marginBottom: '1.5rem', backgroundColor: 'transparent' }}>
          <h3 style={{ margin: 0 }}>
            {currentView === 'home' ? 'Home' : systemModules.find(m => m.slug === currentView)?.name || 'Dashboard'}
          </h3>
        </header>

        <main className="content-area">
          {currentView === 'roles' && <Roles user={user} />}
          {currentView === 'registration' && <RegistrationBuilder />}
          {currentView === 'branding' && <Branding user={user} />}
          {currentView === 'cluster' && <ClusterDashboard user={user} />}
          
          {currentView === 'manage-users' && (
            <>
              <div className="flex justify-between items-center mb-4">
                <div className="flex gap-4">
                  <button 
                    className={activeTab === 'existing' ? 'primary' : 'outline'} 
                    onClick={() => setActiveTab('existing')}
                  >
                    Existing Users
                  </button>
                  <button 
                    className={activeTab === 'pending' ? 'primary' : 'outline'} 
                    onClick={() => setActiveTab('pending')}
                  >
                    Pending Approval ({pendingRequests.length})
                  </button>
                </div>
                <button 
                  className="outline" 
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  onClick={fetchUsers}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                  Refresh
                </button>
              </div>

              {activeTab === 'pending' && (
                <div className="flex-col gap-4">
                  {pendingRequests.length === 0 && <p className="text-muted">No pending requests.</p>}
                  {pendingRequests.map(req => {
                    const reqData = JSON.parse(req.data || '{}');
                    const { fullName, formattedData } = getDisplayData(req, reqData);
                    return (
                      <div key={req.id} className="card">
                        <div className="flex justify-between items-center">
                          <div>
                            <div style={{ fontWeight: 'bold' }}>{fullName}</div>
                            <div className="text-sm text-muted">
                              {Object.entries(formattedData).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                            </div>
                            <div className="text-sm text-muted mt-2">
                              Form: <strong>{req.form?.name}</strong> | Requested Role ID: <strong>{req.requestedRoleId}</strong>
                            </div>
                          </div>
                          <div className="flex-col gap-2">
                            <select 
                              id={`role-${req.id}`} 
                              defaultValue={req.requestedRoleId} 
                              style={{ marginBottom: '0.5rem' }}
                            >
                              {roles.map(r => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                              ))}
                            </select>
                            <div className="flex gap-2">
                              <button 
                                className="success" 
                                style={{ backgroundColor: 'var(--success)', color: 'white' }}
                                onClick={() => {
                                  const select = document.getElementById(`role-${req.id}`) as HTMLSelectElement;
                                  handleAction(req.id, 'approve', { roleId: Number(select.value) }, true);
                                }}
                              >
                                Approve
                              </button>
                              <button 
                                className="danger"
                                onClick={() => {
                                  const reason = prompt('Rejection reason (optional):');
                                  handleAction(req.id, 'reject', { reason }, true);
                                }}
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'existing' && (
                <div className="flex-col">
                  {Object.entries(usersByRole).map(([roleName, roleUsers]) => (
                    <div key={roleName}>
                      <div 
                        className="accordion-header" 
                        onClick={() => setOpenSection(openSection === roleName ? null : roleName)}
                      >
                        <div className="flex gap-4 items-center">
                          <span className="badge" style={{ backgroundColor: 'var(--secondary)' }}>{(roleUsers as any[]).length}</span>
                          <span>{roleName}</span>
                        </div>
                        <span>{openSection === roleName ? '▲' : '▼'}</span>
                      </div>
                      
                      {openSection === roleName && (
                        <div className="accordion-content">
                          {(roleUsers as any[]).map((u: any) => (
                            <div key={u.id} className="user-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                              <div className="flex justify-between items-start">
                                <div>
                                  <div style={{ fontWeight: 'bold' }}>{u.fullName}</div>
                                  <div className="text-sm text-muted">{u.employeeId} | {u.department}</div>
                                </div>
                                <div className="flex items-center gap-4">
                                  <span className={`badge ${u.status.toLowerCase()}`}>{u.status}</span>
                                  {u.status === 'DEACTIVATED' ? (
                                    <button className="primary" onClick={() => setConfirmModal({ id: u.id, action: 'reactivate', name: u.fullName })}>Reactivate</button>
                                  ) : (
                                    <button className="danger outline" onClick={() => setConfirmModal({ id: u.id, action: 'deactivate', name: u.fullName })}>Deactivate</button>
                                  )}
                                </div>
                              </div>
                              <div className="text-sm bg-gray-50" style={{ padding: 16, borderRadius: 8, backgroundColor: '#fdfdfd', border: '1px solid #e0e0e0', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)' }}>
                                {(() => {
                                  try {
                                    const meta = JSON.parse(u.metadata || '{}');
                                    const cleanedMeta: Record<string, any> = {};
                                    for (const [k, v] of Object.entries(meta)) {
                                      if (k.toLowerCase().includes('password')) continue;
                                      if (k.startsWith('field_')) continue; // Should not exist, but just in case skip them
                                      cleanedMeta[k] = v;
                                    }

                                    if (Object.keys(cleanedMeta).length === 0) return <span className="text-muted">No additional details</span>;
                                    
                                    return (
                                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                        {Object.entries(cleanedMeta).map(([k, v]) => (
                                          <div key={k} style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span className="text-muted" style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{k}</span>
                                            <strong style={{ color: '#333' }}>{Array.isArray(v) ? v.join(', ') : String(v)}</strong>
                                          </div>
                                        ))}
                                      </div>
                                    );
                                  } catch (e) {
                                    return null;
                                  }
                                })()}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {currentView === 'home' && (
            <div className="card text-center" style={{ padding: 64, marginTop: 32 }}>
              <h2 style={{ fontSize: '2rem', color: 'var(--primary)', marginBottom: 16 }}>Welcome to LC Platform</h2>
              <p className="text-muted" style={{ fontSize: '1.2rem' }}>You are logged in as <strong>{user.role}</strong>.</p>
            </div>
          )}
        </main>
      </div>
      {confirmModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: '400px' }}>
            <h3 style={{ marginTop: 0 }}>Confirm Action</h3>
            <p>
              Are you sure you want to <strong>{confirmModal.action}</strong> user <strong>{confirmModal.name}</strong>?
              {confirmModal.action === 'deactivate' && ' They will no longer be able to log in.'}
            </p>
            <div className="flex gap-4" style={{ marginTop: '2rem', justifyContent: 'flex-end' }}>
              <button className="outline" onClick={() => setConfirmModal(null)}>Cancel</button>
              <button 
                className={confirmModal.action === 'deactivate' ? 'danger' : 'primary'}
                style={confirmModal.action === 'reactivate' ? { backgroundColor: 'var(--success)', color: 'white' } : {}}
                onClick={() => {
                  handleAction(confirmModal.id, confirmModal.action);
                  setConfirmModal(null);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
