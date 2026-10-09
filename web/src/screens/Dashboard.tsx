import { useEffect, useState } from 'react';
import type { User } from '../types';
import Roles from './Roles';
import RegistrationBuilder from './RegistrationBuilder';
import Branding from './Branding';

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

  useEffect(() => {
    fetchRoles();
    fetchUsers();
    fetchSystemModules();
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
      <div className="sidebar">
        <div className="sidebar-header">
          LC Platform
        </div>
        <div className="sidebar-profile">
          <div className="avatar">
            {user.fullName.substring(0, 2).toUpperCase()}
          </div>
          <div>
            <div style={{ fontWeight: 'bold' }}>{user.fullName}</div>
            <div className="text-sm text-muted">{user.role}</div>
          </div>
        </div>
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

          <a href="#" className="nav-item text-danger mt-4" onClick={(e) => { e.preventDefault(); onLogout(); }}>Logout</a>
        </nav>
      </div>

      <div className="main-content">
        <header className="header">
          <h3>
            {currentView === 'home' ? 'Home' : systemModules.find(m => m.slug === currentView)?.name || 'Dashboard'}
          </h3>
        </header>

        <main className="content-area">
          {currentView === 'roles' && <Roles user={user} />}
          {currentView === 'registration' && <RegistrationBuilder />}
          {currentView === 'branding' && <Branding user={user} />}
          
          {currentView === 'manage-users' ? (
            <>
              <div className="flex gap-4 mb-4">
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
                              <div className="text-sm bg-gray-50" style={{ padding: 12, borderRadius: 8, backgroundColor: '#f9f9f9', border: '1px solid #eee' }}>
                                {(() => {
                                  try {
                                    const meta = JSON.parse(u.metadata || '{}');
                                    if (Object.keys(meta).length === 0) return <span className="text-muted">No additional details</span>;
                                    return (
                                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                        {Object.entries(meta).map(([k, v]) => (
                                          <div key={k}>
                                            <span className="text-muted">{k}:</span>{' '}
                                            <strong>{Array.isArray(v) ? v.join(', ') : String(v)}</strong>
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
          ) : (
            <div className="card text-center">
              <h2>Welcome to LC Platform</h2>
              <p className="text-muted mt-4">You are logged in as {user.role}.</p>
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
