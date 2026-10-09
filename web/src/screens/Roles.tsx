import { useEffect, useState } from 'react';
import type { User } from '../types';

type Props = {
  user: User;
};

export default function Roles({}: Props) {
  const [roles, setRoles] = useState<any[]>([]);
  const [modules, setModules] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  
  const [formData, setFormData] = useState({ name: '', moduleIds: [] as number[] });

  const fetchData = async () => {
    try {
      const [rolesRes, modsRes] = await Promise.all([
        fetch('http://localhost:5001/api/v1/roles', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }}),
        fetch('http://localhost:5001/api/v1/modules', { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }})
      ]);
      setRoles(await rolesRes.json());
      setModules(await modsRes.json());
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingRole ? `http://localhost:5001/api/v1/roles/${editingRole.id}` : 'http://localhost:5001/api/v1/roles';
    const method = editingRole ? 'PUT' : 'POST';
    
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        setShowModal(false);
        fetchData();
      } else {
        const errorData = await res.json();
        alert(errorData.error || 'Failed to save role');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this role?')) return;
    try {
      const res = await fetch(`http://localhost:5001/api/v1/roles/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        fetchData();
      } else {
        const err = await res.json();
        alert(err.error);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openCreateModal = () => {
    setEditingRole(null);
    setFormData({ name: '', moduleIds: [] });
    setShowModal(true);
  };

  const openEditModal = (role: any) => {
    setEditingRole(role);
    setFormData({ name: role.name, moduleIds: role.roleModules.map((rm: any) => rm.moduleId) });
    setShowModal(true);
  };

  const toggleModule = (modId: number) => {
    setFormData(prev => ({
      ...prev,
      moduleIds: prev.moduleIds.includes(modId)
        ? prev.moduleIds.filter(id => id !== modId)
        : [...prev.moduleIds, modId]
    }));
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2>Manage Roles</h2>
        <button className="primary" onClick={openCreateModal}>Create Role</button>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {roles.map(r => (
          <div key={r.id} className="card">
            <h3>{r.name}</h3>
            <div className="mt-2 mb-4 text-sm text-muted">
              {r.roleModules && r.roleModules.length > 0
                ? r.roleModules.map((rm: any) => rm.module.name).join(', ')
                : 'No modules access'}
            </div>
            {r.name !== 'Developer' && (
              <div className="flex gap-2">
                <button className="outline" onClick={() => openEditModal(r)}>Edit</button>
                <button className="danger outline" onClick={() => handleDelete(r.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div className="card" style={{ width: '100%', maxWidth: '500px', backgroundColor: 'white' }}>
            <h3>{editingRole ? 'Edit Role' : 'Create Role'}</h3>
            <form onSubmit={handleSave} className="flex-col gap-4 mt-4">
              <div>
                <label>Role Name</label>
                <input 
                  type="text" 
                  value={formData.name} 
                  onChange={e => setFormData({ ...formData, name: e.target.value })} 
                  required 
                />
              </div>
              <div>
                <label>Allowed Modules</label>
                <div className="flex flex-col gap-2 mt-2" style={{ alignItems: 'flex-start' }}>
                  {modules.map(mod => (
                    <label key={mod.id} className="flex items-center gap-2">
                      <input 
                        type="checkbox" 
                        checked={formData.moduleIds.includes(mod.id)}
                        onChange={() => toggleModule(mod.id)}
                      />
                      {mod.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button type="button" className="outline" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="primary">Save Role</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
