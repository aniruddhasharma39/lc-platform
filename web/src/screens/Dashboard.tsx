import React, { useEffect, useState } from 'react';
import type { User } from '../types';

type Props = {
  user: User;
  onLogout: () => void;
};

export default function Dashboard({ user, onLogout }: Props) {
  const [users, setUsers] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<'home' | 'manageUsers'>('home');

  const fetchUsers = async () => {
    if (user.role !== 'Developer') return;
    try {
      const res = await fetch('http://localhost:5001/api/v1/users', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setUsers(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRoles = async () => {
    try {
      const res = await fetch('http://localhost:5001/api/v1/users/roles');
      const data = await res.json();
      setRoles(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchRoles();
    fetchUsers();
  }, []);

  const handleAction = async (userId: number, action: string, body = {}) => {
    try {
      await fetch(`http://localhost:5001/api/v1/users/${userId}/${action}`, {
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

  const pendingUsers = users.filter(u => u.status === 'PENDING');
  
  const usersByRole = users.reduce((acc, curr) => {
    if (curr.status === 'PENDING') return acc; // Exclude pending from existing list
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
          {user.role === 'Developer' && (
            <a href="#" className={`nav-item ${currentView === 'manageUsers' ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); setCurrentView('manageUsers'); }}>Manage Users</a>
          )}
          <a href="#" className="nav-item text-danger mt-4" onClick={(e) => { e.preventDefault(); onLogout(); }}>Logout</a>
        </nav>
      </div>

      <div className="main-content">
        <header className="header">
          <h3>{currentView === 'manageUsers' ? 'Manage Users' : 'Home'}</h3>
        </header>

        <main className="content-area">
          {currentView === 'manageUsers' && user.role === 'Developer' ? (
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
                  Pending Approval ({pendingUsers.length})
                </button>
              </div>

              {activeTab === 'pending' && (
                <div className="flex-col gap-4">
                  {pendingUsers.length === 0 && <p className="text-muted">No pending users.</p>}
                  {pendingUsers.map(u => (
                    <div key={u.id} className="card">
                      <div className="flex justify-between items-center">
                        <div>
                          <div style={{ fontWeight: 'bold' }}>{u.fullName} ({u.employeeId})</div>
                          <div className="text-sm text-muted">
                            {u.mobile} | {u.email} | {u.department}
                          </div>
                          <div className="text-sm text-muted mt-2">
                            Requested Role: <strong>{u.requestedRole?.name}</strong>
                          </div>
                        </div>
                        <div className="flex-col gap-2">
                          <select 
                            id={`role-${u.id}`} 
                            defaultValue={u.requestedRoleId} 
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
                                const select = document.getElementById(`role-${u.id}`) as HTMLSelectElement;
                                handleAction(u.id, 'approve', { roleId: Number(select.value) });
                              }}
                            >
                              Approve
                            </button>
                            <button 
                              className="danger"
                              onClick={() => {
                                const reason = prompt('Rejection reason (optional):');
                                handleAction(u.id, 'reject', { reason });
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
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
                          <span className="badge" style={{ backgroundColor: 'var(--secondary)' }}>{roleUsers.length}</span>
                          <span>{roleName}</span>
                        </div>
                        <span>{openSection === roleName ? '▲' : '▼'}</span>
                      </div>
                      
                      {openSection === roleName && (
                        <div className="accordion-content">
                          {roleUsers.map(u => (
                            <div key={u.id} className="user-card">
                              <div>
                                <div style={{ fontWeight: 'bold' }}>{u.fullName}</div>
                                <div className="text-sm text-muted">{u.employeeId} | {u.department}</div>
                              </div>
                              <div className="flex items-center gap-4">
                                <span className={`badge ${u.status.toLowerCase()}`}>{u.status}</span>
                                {u.status === 'DEACTIVATED' ? (
                                  <button className="primary" onClick={() => handleAction(u.id, 'reactivate')}>Reactivate</button>
                                ) : (
                                  <button className="danger outline" onClick={() => handleAction(u.id, 'deactivate')}>Deactivate</button>
                                )}
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
    </div>
  );
}
