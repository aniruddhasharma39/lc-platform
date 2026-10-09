import React, { useState, useEffect } from 'react';
import type { User } from '../../types';
import './ClusterDashboard.css';

type Props = {
  user: User;
};

export default function ClusterDashboard(_props: Props) {
  const [gates, setGates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'list' | 'create_gate' | 'gate_detail'>('list');
  const [selectedGate, setSelectedGate] = useState<any>(null);

  // Modals
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const fetchGates = async () => {
    setLoading(true);
    try {
      const res = await fetch('https://lc-platform.onrender.com/api/v1/lcgate', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setGates(data);
        if (selectedGate) {
          const updated = data.find((g: any) => g.id === selectedGate.id);
          if (updated) setSelectedGate(updated);
        }
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchGates();
  }, []);

  const handleDeleteGate = async () => {
    if (deleteConfirmText !== selectedGate.name && deleteConfirmText !== selectedGate.lcNumber) {
      alert("Name does not match!");
      return;
    }
    try {
      const res = await fetch(`https://lc-platform.onrender.com/api/v1/lcgate/${selectedGate.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        setShowDeleteModal(false);
        setDeleteConfirmText('');
        setSelectedGate(null);
        setView('list');
        fetchGates();
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="cluster-container fade-in">
      {view === 'list' && (
        <div className="gate-list-view">
          <div className="flex justify-between items-center mb-6">
            <h2 className="title-gradient">LC Gate Clusters</h2>
            <button className="btn-primary flex items-center gap-2 pulse-hover" onClick={() => setView('create_gate')}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14m-7-7h14"/></svg>
              Create New Gate
            </button>
          </div>
          
          {loading ? (
            <div className="spinner-container"><div className="spinner"></div></div>
          ) : gates.length === 0 ? (
            <div className="empty-state glass-card">
              <div className="empty-icon">🏗️</div>
              <h3>No Gates Found</h3>
              <p>Get started by creating your first Level Crossing Gate.</p>
            </div>
          ) : (
            <div className="grid">
              {gates.map(gate => (
                <div key={gate.id} className="gate-card glass-card hover-lift" onClick={() => { setSelectedGate(gate); setView('gate_detail'); }} style={{ padding: '24px', cursor: 'pointer' }}>
                  <div className="gate-header flex justify-between items-start" style={{ marginBottom: '28px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
                      <h3 className="m-0" style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-main)', lineHeight: '1.2' }}>{gate.name || 'Unnamed Gate'}</h3>
                      <span className="badge badge-blue" style={{ fontSize: '0.85rem', padding: '6px 12px', letterSpacing: '0.5px' }}>{gate.lcNumber || 'No LC#'}</span>
                    </div>
                    <button 
                      className="transition flex items-center justify-center rounded-full hover-lift"
                      style={{ backgroundColor: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', padding: '12px', cursor: 'pointer', border: 'none' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedGate(gate);
                        setShowDeleteModal(true);
                      }}
                      title="Delete Gate"
                      onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#ef4444'; e.currentTarget.style.color = '#ffffff'; }}
                      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                  <div className="gate-body text-sm" style={{ display: 'flex', flexDirection: 'column', gap: '20px', color: 'var(--text-main)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                      <div style={{ backgroundColor: 'var(--secondary)', color: 'white', width: '42px', height: '42px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> 
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>Location</span>
                        <span style={{ fontWeight: 500, fontSize: '1.05rem' }}>{gate.locationName}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                      <div style={{ backgroundColor: 'var(--primary)', color: 'white', width: '42px', height: '42px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', fontWeight: 700 }}>Master Units</span>
                        <span style={{ fontWeight: 500, fontSize: '1.05rem' }}>{gate.masters?.length || 0} Registered</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'create_gate' && (
        <CreateGateForm 
          onCancel={() => setView('list')} 
          onSuccess={() => { setView('list'); fetchGates(); }} 
        />
      )}

      {view === 'gate_detail' && selectedGate && (
        <GateDetailView 
          gate={selectedGate} 
          onBack={() => { setView('list'); setSelectedGate(null); }} 
          onUpdate={fetchGates}
        />
      )}

      {showDeleteModal && (
        <div className="modal-overlay fade-in">
          <div className="modal-content glass-card scale-in danger-border">
            <h3 className="text-danger mb-4">Are you absolutely sure?</h3>
            <p className="text-sm mb-4">
              This action <strong>cannot</strong> be undone. This will permanently delete the 
              <strong> {selectedGate.name || selectedGate.lcNumber}</strong> gate, 
              all its master units, child devices, and photographic evidence.
            </p>
            <p className="text-sm mb-2">Please type <strong>{selectedGate.name || selectedGate.lcNumber}</strong> to confirm.</p>
            <input 
              type="text" 
              className="glass-input w-full mb-4" 
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
            />
            <div className="flex gap-4 justify-end">
              <button className="btn-outline" onClick={() => setShowDeleteModal(false)}>Cancel</button>
              <button 
                className="btn-danger" 
                disabled={deleteConfirmText !== (selectedGate.name || selectedGate.lcNumber)}
                onClick={handleDeleteGate}
              >
                I understand the consequences, delete this gate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateGateForm({ onCancel, onSuccess }: any) {
  const [name, setName] = useState('');
  const [lcNumberDigits, setLcNumberDigits] = useState('');
  const [locationName, setLocationName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [gettingLocation, setGettingLocation] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleGetLocation = (e: React.MouseEvent) => {
    e.preventDefault();
    setGettingLocation(true);
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLat(position.coords.latitude.toString());
          setLng(position.coords.longitude.toString());
          setGettingLocation(false);
        },
        (error) => {
          alert(`Error getting location: ${error.message}`);
          setGettingLocation(false);
        },
        { enableHighAccuracy: true }
      );
    } else {
      alert("Geolocation is not supported by your browser");
      setGettingLocation(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('https://lc-platform.onrender.com/api/v1/lcgate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          name: name || undefined,
          lcNumberDigits,
          locationName,
          latitude: lat ? parseFloat(lat) : undefined,
          longitude: lng ? parseFloat(lng) : undefined
        })
      });
      if (res.ok) {
        onSuccess();
      } else {
        const err = await res.json();
        alert(`Error: ${err.error || 'Failed to create gate'}`);
      }
    } catch (e) {
      console.error(e);
      alert('Network error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="title-gradient m-0">Create New LC Gate</h3>
        <button className="btn-icon" onClick={onCancel}>✕</button>
      </div>
      
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        <div className="form-group">
          <label>Gate Name (Optional)</label>
          <input className="glass-input" type="text" placeholder="e.g. North Gate" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label>LC Number (4 Digits) *</label>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg" style={{ color: 'var(--primary-color)' }}>LC -</span>
            <input 
              className="glass-input flex-1" 
              type="text" 
              required 
              placeholder="0001" 
              maxLength={4} 
              pattern="\d{4}" 
              title="Must be exactly 4 digits"
              value={lcNumberDigits} 
              onChange={e => setLcNumberDigits(e.target.value.replace(/\D/g, ''))} 
            />
          </div>
        </div>
        <div className="form-group">
          <label>Location Description *</label>
          <input className="glass-input" type="text" required placeholder="e.g. Near Station X" value={locationName} onChange={e => setLocationName(e.target.value)} />
        </div>
        
        <div className="location-box glass-panel p-4 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <label className="m-0">GPS Coordinates</label>
            <button className="btn-small btn-primary flex items-center gap-1" onClick={handleGetLocation} disabled={gettingLocation}>
              {gettingLocation ? 'Locating...' : '📍 Auto-fill GPS'}
            </button>
          </div>
          <div className="flex gap-4">
            <input className="glass-input flex-1" type="number" step="any" placeholder="Latitude" value={lat} onChange={e => setLat(e.target.value)} />
            <input className="glass-input flex-1" type="number" step="any" placeholder="Longitude" value={lng} onChange={e => setLng(e.target.value)} />
          </div>
        </div>

        <button type="submit" className="btn-primary w-full mt-4 py-3 text-lg" disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Gate'}
        </button>
      </form>
    </div>
  );
}

function GateDetailView({ gate, onBack, onUpdate }: any) {
  const [addingMaster, setAddingMaster] = useState(false);
  const [addingDeviceToMaster, setAddingDeviceToMaster] = useState<number | null>(null);
  const [uploadingEvidenceFor, setUploadingEvidenceFor] = useState<any>(null);

  const [masterToDelete, setMasterToDelete] = useState<any>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const executeDeleteMaster = async (masterId: number) => {
    try {
      const res = await fetch(`https://lc-platform.onrender.com/api/v1/lcgate/masters/${masterId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        setMasterToDelete(null);
        setDeleteConfirmText('');
        onUpdate();
      } else {
        alert('Failed to delete master unit');
      }
    } catch (e) {
      console.error(e);
    }
  };

  const executeDeleteDevice = async (deviceId: number) => {
    if (!window.confirm("Are you sure you want to delete this Slave Device?")) return;
    try {
      const res = await fetch(`https://lc-platform.onrender.com/api/v1/lcgate/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        onUpdate();
      } else {
        alert('Failed to delete slave device');
      }
    } catch (e) {
      console.error(e);
    }
  }; // For centralized evidence upload

  return (
    <div className="slide-up">
      <div className="flex justify-between items-center mb-8 border-b pb-4" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
        <div className="flex items-center gap-4">
          <button 
            className="transition flex items-center justify-center rounded-full hover-lift" 
            style={{ backgroundColor: 'white', border: '1px solid var(--border)', width: '48px', height: '48px', color: 'var(--text-main)', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', cursor: 'pointer' }}
            onClick={onBack} 
            aria-label="Go Back"
          >
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <div>
            <h2 className="m-0" style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-main)' }}>
              {gate.name || 'Unnamed Gate'}
            </h2>
            {gate.lcNumber && (
              <div className="badge badge-indigo mt-2 inline-block" style={{ fontSize: '0.9rem', padding: '6px 12px', fontWeight: 600 }}>{gate.lcNumber}</div>
            )}
          </div>
        </div>
      </div>

      {!addingMaster && !addingDeviceToMaster && !uploadingEvidenceFor && (
        <>
          <div className="flex justify-between items-center mb-6">
            <h3 className="m-0 text-xl font-bold">Master Units</h3>
            <button className="btn-primary flex items-center gap-2" onClick={() => setAddingMaster(true)}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14m-7-7h14"/></svg> 
              <span>Add Master</span>
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', width: '100%' }}>
            {gate.masters?.length === 0 ? (
              <div className="empty-state-dashed col-span-full">
                <div className="empty-icon text-4xl mb-3">⚙️</div>
                <h4 className="text-lg font-bold mb-1">No Master Units</h4>
                <p className="text-muted m-0">Click "Add Master" to configure the ESP for this LC Gate.</p>
              </div>
            ) : (
              gate.masters?.map((master: any) => (
                <div key={master.id} className="master-card glass-card" style={{ width: '100%' }}>
                  <div className="flex justify-between items-center mb-4">
                    <div>
                      <h4 className="m-0 mb-2" style={{ fontSize: '1.4rem', fontWeight: 700 }}>{master.serialNumber}</h4>
                    </div>
                    <div className="flex items-center gap-3">
                      <button 
                        className="btn-small btn-outline flex items-center gap-2 hover-lift" 
                        style={{ padding: '8px 12px', fontSize: '0.85rem', cursor: 'pointer' }}
                        onClick={() => setUploadingEvidenceFor(master)}
                      >
                        <span style={{ fontSize: '1rem' }}>📷</span> Upload Evidence
                      </button>
                      <button 
                        className="transition flex items-center justify-center rounded-md hover-lift" 
                        style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '10px', border: 'none', cursor: 'pointer' }}
                        onClick={() => setMasterToDelete(master)} 
                        title="Delete Master Unit"
                        onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#ef4444'; e.currentTarget.style.color = '#ffffff'; }}
                        onMouseOut={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'; e.currentTarget.style.color = '#ef4444'; }}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </div>
                  
                  <div className="mb-6 text-sm flex items-center gap-2" style={{ color: 'var(--text-main)', fontSize: '0.95rem' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Power Source:</span> 
                    <span style={{ fontWeight: 600 }}>{master.powerSource === 'SOLAR' ? '☀️ Solar Power' : '🔌 Direct Current'}</span>
                  </div>
                  
                  <div className="child-devices-panel p-4 rounded-xl" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div className="flex justify-between items-center mb-4">
                      <h5 className="m-0" style={{ fontSize: '1.1rem', fontWeight: 700 }}>Slave Devices</h5>
                      <button className="btn-small btn-primary hover-lift" style={{ padding: '6px 12px', fontSize: '0.85rem', cursor: 'pointer' }} onClick={() => setAddingDeviceToMaster(master)}>+ Add Slave</button>
                    </div>
                    {master.childDevices?.length === 0 ? (
                      <div className="text-sm text-muted italic p-6 text-center border-dashed rounded-lg" style={{ borderWidth: '2px', borderColor: 'var(--border)' }}>No slave devices connected yet.</div>
                    ) : (
                      <ul className="device-list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
                        {master.childDevices?.map((dev: any) => (
                          <li key={dev.id} className="device-item p-4 rounded-xl transition hover-lift" style={{ backgroundColor: 'var(--background)', border: '1px solid var(--border)', boxShadow: '0 2px 8px rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div className="flex justify-between items-start gap-4">
                              <div className="flex items-center gap-3">
                                <div style={{ backgroundColor: 'rgba(11, 60, 122, 0.08)', padding: '8px', borderRadius: '8px', display: 'flex' }}>
                                  <span className="text-xl" role="img" aria-label="plugin">🔌</span>
                                </div>
                                <strong style={{ fontSize: '1.05rem', color: 'var(--text-main)', whiteSpace: 'nowrap' }}>{dev.serialNumber}</strong>
                              </div>
                              <button 
                                className="transition flex items-center justify-center rounded-md flex-shrink-0" 
                                style={{ backgroundColor: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', padding: '6px', border: 'none', cursor: 'pointer', width: '32px', height: '32px' }}
                                onClick={() => executeDeleteDevice(dev.id)} 
                                title="Delete Slave Device"
                                onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#ef4444'; e.currentTarget.style.color = '#ffffff'; }}
                                onMouseOut={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.08)'; e.currentTarget.style.color = '#ef4444'; }}
                              >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                              </button>
                            </div>
                            
                            <div className="flex justify-between items-center gap-4">
                              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 500, lineHeight: '1.3' }}>
                                {dev.type === 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor'}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center' }}>
                                <span className="badge badge-blue" style={{ whiteSpace: 'nowrap', fontWeight: 700, padding: '4px 10px', fontSize: '0.75rem', letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: '6px' }}>
                                  {dev.type === 'DEVICE_1' ? 'Type A' : 'Type B'}
                                </span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {masterToDelete && (
        <div className="modal-overlay fade-in">
          <div className="modal-content glass-card scale-in danger-border">
            <h3 className="text-danger mb-4">Delete Master Unit?</h3>
            <p className="text-sm mb-4">
              This action <strong>cannot</strong> be undone. This will permanently delete the 
              Master Unit <strong>{masterToDelete.serialNumber}</strong>, and all of its Slave Devices and evidence.
            </p>
            <p className="text-sm mb-2">Please type <strong>{masterToDelete.serialNumber}</strong> to confirm.</p>
            <input 
              type="text" 
              className="glass-input w-full mb-4" 
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
            />
            <div className="flex gap-4 justify-end">
              <button className="btn-outline" onClick={() => { setMasterToDelete(null); setDeleteConfirmText(''); }}>Cancel</button>
              <button 
                className="btn-danger" 
                disabled={deleteConfirmText !== masterToDelete.serialNumber}
                onClick={() => executeDeleteMaster(masterToDelete.id)}
              >
                Delete Master Unit
              </button>
            </div>
          </div>
        </div>
      )}

      {addingMaster && (
        <CreateMasterForm gate={gate} onCancel={() => setAddingMaster(false)} onSuccess={() => { setAddingMaster(false); onUpdate(); }} />
      )}

      {addingDeviceToMaster && (
        <CreateDeviceForm master={addingDeviceToMaster} onCancel={() => setAddingDeviceToMaster(null)} onSuccess={() => { setAddingDeviceToMaster(null); onUpdate(); }} />
      )}

      {uploadingEvidenceFor && (
        <CentralizedEvidenceUpload 
          master={uploadingEvidenceFor} 
          onClose={() => { setUploadingEvidenceFor(null); onUpdate(); }} 
        />
      )}
    </div>
  );
}

function CreateMasterForm({ gate, onCancel, onSuccess }: any) {
  const [masterSequence, setMasterSequence] = useState('1');
  const [powerSource, setPowerSource] = useState('SOLAR');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`https://lc-platform.onrender.com/api/v1/lcgate/${gate.id}/next-master-sequence`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.nextSequence) setMasterSequence(data.nextSequence.toString());
      })
      .catch(console.error);
  }, [gate.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`https://lc-platform.onrender.com/api/v1/lcgate/${gate.id}/masters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ masterSequence: parseInt(masterSequence, 10), powerSource })
      });
      if (res.ok) onSuccess();
      else {
        const err = await res.json();
        alert(err.error || 'Failed');
      }
    } catch (e) {
      console.error(e);
      alert('Error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="m-0 title-gradient">Add Master Unit</h3>
        <button className="btn-icon" onClick={onCancel}>✕</button>
      </div>
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        <div className="form-group">
          <label>Master Sequence (2 Digits) *</label>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg" style={{ color: 'var(--primary-color)' }}>{gate.lcNumber}-</span>
            <input 
              className="glass-input flex-1" 
              style={{ backgroundColor: 'rgba(0,0,0,0.05)', cursor: 'not-allowed' }}
              type="text" 
              readOnly
              value={masterSequence.padStart(2, '0')} 
            />
          </div>
          <small className="text-muted mt-1 block">This sequence is auto-generated and cannot be changed.</small>
        </div>
        <div className="form-group">
          <label>Power Source *</label>
          <select className="glass-input" value={powerSource} onChange={e => setPowerSource(e.target.value)}>
            <option value="SOLAR">☀️ Solar Power</option>
            <option value="DIRECT">🔌 Direct Current Supply</option>
          </select>
        </div>
        <button type="submit" className="btn-primary w-full mt-4 py-3" disabled={submitting}>
          {submitting ? 'Saving...' : 'Create Master Unit'}
        </button>
      </form>
    </div>
  );
}

function CreateDeviceForm({ master, onCancel, onSuccess }: any) {
  const [type, setType] = useState('DEVICE_1');
  const [deviceSequence, setDeviceSequence] = useState('1');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`https://lc-platform.onrender.com/api/v1/lcgate/masters/${master.id}/next-device-sequence?type=${type}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.nextSequence) setDeviceSequence(data.nextSequence.toString());
      })
      .catch(console.error);
  }, [master.id, type]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`https://lc-platform.onrender.com/api/v1/lcgate/masters/${master.id}/devices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ type, deviceSequence: parseInt(deviceSequence, 10) })
      });
      if (res.ok) onSuccess();
      else {
        const err = await res.json();
        alert(err.error || 'Failed');
      }
    } catch (e) {
      console.error(e);
      alert('Error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="m-0 title-gradient">Add Slave Device</h3>
        <button className="btn-icon" onClick={onCancel}>✕</button>
      </div>
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        <div className="form-group">
          <label>Device Type *</label>
          <select className="glass-input" value={type} onChange={e => setType(e.target.value)}>
            <option value="DEVICE_1">Device 1 (Hall Effect + Limit Switch)</option>
            <option value="DEVICE_2">Device 2 (Tilt Sensor)</option>
          </select>
        </div>
        <div className="form-group">
          <label>Device Sequence (2 Digits) *</label>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg" style={{ color: 'var(--primary-color)' }}>
              {master.serialNumber}-{type === 'DEVICE_1' ? 'A' : 'B'}
            </span>
            <input 
              className="glass-input flex-1" 
              style={{ backgroundColor: 'rgba(0,0,0,0.05)', cursor: 'not-allowed' }}
              type="text" 
              readOnly
              value={deviceSequence.padStart(2, '0')} 
            />
          </div>
          <small className="text-muted mt-1 block">This sequence is auto-generated and cannot be changed.</small>
        </div>
        <button type="submit" className="btn-primary w-full mt-4 py-3" disabled={submitting}>
          {submitting ? 'Saving...' : 'Add Slave Device'}
        </button>
      </form>
    </div>
  );
}

function CentralizedEvidenceUpload({ master, onClose }: any) {
  const evidences = master.evidences || [];
  const hasMasterEv = evidences.some((e: any) => e.category === 'MASTER');
  const hasPowerEv = evidences.some((e: any) => e.category === 'POWER_SOURCE');

  return (
    <div className="glass-card slide-up">
      <div className="flex justify-between items-center mb-6 border-b pb-4 border-opacity-20 border-white">
        <h3 className="m-0 title-gradient">Upload Evidence Checklist</h3>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>
      
      <p className="text-muted mb-6">Upload photographic evidence for all components of Master {master.serialNumber}. Photos will be securely geo-stamped.</p>

      <div className="evidence-list grid gap-4">
        {/* Master ESP */}
        <EvidenceItem 
          title="Master Unit (ESP)" 
          description="Photo showing the ESP installation"
          isDone={hasMasterEv}
          masterId={master.id}
          category="MASTER"
        />

        {/* Power Source */}
        <EvidenceItem 
          title={`${master.powerSource === 'SOLAR' ? 'Solar Panel' : 'Direct Power'} Source`}
          description={`Photo verifying the ${master.powerSource} installation`}
          isDone={hasPowerEv}
          masterId={master.id}
          category="POWER_SOURCE"
        />

        {/* Child Devices */}
        {master.childDevices?.map((dev: any) => {
          const hasDevEv = evidences.some((e: any) => e.category === dev.type && e.childDeviceId === dev.id);
          return (
            <EvidenceItem 
              key={dev.id}
              title={`Slave ${dev.type}`} 
              description={dev.type === 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor'}
              isDone={hasDevEv}
              masterId={master.id}
              childDeviceId={dev.id}
              category={dev.type}
            />
          );
        })}
      </div>
    </div>
  );
}

function EvidenceItem({ title, description, isDone, masterId, childDeviceId, category }: any) {
  const [uploading, setUploading] = useState(false);
  const [doneStatus, setDoneStatus] = useState(isDone);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64String = reader.result as string;

        // Auto-fetch GPS
        navigator.geolocation.getCurrentPosition(async (pos) => {
          const res = await fetch('https://lc-platform.onrender.com/api/v1/evidence', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({
              masterId,
              childDeviceId,
              category,
              imageBase64: base64String,
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude
            })
          });

          if (res.ok) setDoneStatus(true);
          else alert('Upload failed');
          setUploading(false);
        }, () => {
          alert('GPS is required for evidence upload.');
          setUploading(false);
        }, { enableHighAccuracy: true });
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      setUploading(false);
    }
  };

  return (
    <div className={`evidence-item flex justify-between items-center p-4 rounded-xl transition-all ${doneStatus ? 'bg-green-900 bg-opacity-20 border border-green-500' : 'glass-panel'}`}>
      <div>
        <h4 className="m-0 text-lg flex items-center gap-2">
          {doneStatus ? <span className="text-green-500">✅</span> : <span>📷</span>}
          {title}
        </h4>
        <p className="text-sm text-muted m-0 mt-1">{description}</p>
      </div>
      <div>
        {doneStatus ? (
          <span className="badge" style={{backgroundColor: 'var(--success)'}}>Verified</span>
        ) : (
          <label className={`btn-primary cursor-pointer ${uploading ? 'opacity-50' : ''}`}>
            {uploading ? 'Processing...' : 'Upload'}
            <input type="file" accept="image/*" capture="environment" style={{display: 'none'}} onChange={handleFileChange} disabled={uploading}/>
          </label>
        )}
      </div>
    </div>
  );
}
