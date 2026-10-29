import { useEffect, useState, useMemo } from 'react';
import { 
  FaShieldAlt, 
  FaPlus, 
  FaEdit, 
  FaTrash, 
  FaTimes, 
  FaCheck, 
  FaUsers, 
  FaPaintBrush, 
  FaMicrochip, 
  FaFileAlt, 
  FaSearch, 
  FaLock, 
  FaTag, 
  FaLayerGroup, 
  FaCrown,
  FaCheckDouble,
  FaTimesCircle,
  FaExclamationTriangle,
  FaChartBar,
  FaHistory,
  FaVideo,
  FaTrain,
  FaCog,
  FaMapMarkerAlt,
  FaDatabase,
  FaSpinner,
  FaSyncAlt,
} from 'react-icons/fa';
import type { User } from '../types';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';
import './Roles.css';

type Props = {
  user: User;
};

interface ModuleItem {
  id: number;
  slug: string;
  name: string;
}

interface RoleItem {
  id: number;
  name: string;
  roleModules?: {
    moduleId: number;
    module: ModuleItem;
  }[];
}

// Module metadata helper for icons, badges, and descriptions
const getModuleMeta = (name: string, slug?: string) => {
  const key = (slug || name).toLowerCase();
  if (key.includes('cluster') || key.includes('gate') || key.includes('device') || key.includes('barrier')) {
    return {
      icon: FaMicrochip,
      badgeClass: 'badge-cluster',
      desc: 'LC Gate hardware, devices & installation evidence',
    };
  }
  if (key.includes('user') || key.includes('member') || key.includes('staff')) {
    return {
      icon: FaUsers,
      badgeClass: 'badge-users',
      desc: 'User accounts, verification & staff access control',
    };
  }
  if (key.includes('role') || key.includes('permission') || key.includes('access')) {
    return {
      icon: FaShieldAlt,
      badgeClass: 'badge-roles',
      desc: 'Role definitions and module authorization rules',
    };
  }
  if (key.includes('brand') || key.includes('theme') || key.includes('logo')) {
    return {
      icon: FaPaintBrush,
      badgeClass: 'badge-branding',
      desc: 'Railway zone branding, custom logos & themes',
    };
  }
  if (key.includes('regis') || key.includes('form') || key.includes('builder')) {
    return {
      icon: FaFileAlt,
      badgeClass: 'badge-registration',
      desc: 'Custom registration forms & schema configuration',
    };
  }
  if (key.includes('chart') || key.includes('report') || key.includes('analytic')) {
    return {
      icon: FaChartBar,
      badgeClass: 'badge-cluster',
      desc: 'Operational reporting, metrics & analytics',
    };
  }
  if (key.includes('log') || key.includes('audit') || key.includes('history')) {
    return {
      icon: FaHistory,
      badgeClass: 'badge-default',
      desc: 'System event audits, access logs & tracking history',
    };
  }
  if (key.includes('cctv') || key.includes('camera') || key.includes('video')) {
    return {
      icon: FaVideo,
      badgeClass: 'badge-cluster',
      desc: 'Video surveillance feeds & visual inspection',
    };
  }
  if (key.includes('train') || key.includes('rail') || key.includes('track')) {
    return {
      icon: FaTrain,
      badgeClass: 'badge-roles',
      desc: 'Railway track circuits & train operations management',
    };
  }
  if (key.includes('setting') || key.includes('config')) {
    return {
      icon: FaCog,
      badgeClass: 'badge-default',
      desc: 'System-wide preferences and integrations',
    };
  }
  if (key.includes('map') || key.includes('location') || key.includes('gps')) {
    return {
      icon: FaMapMarkerAlt,
      badgeClass: 'badge-registration',
      desc: 'Geographic mapping, GPS positioning & coordinates',
    };
  }
  if (key.includes('data') || key.includes('database')) {
    return {
      icon: FaDatabase,
      badgeClass: 'badge-default',
      desc: 'Database records, backups & data management',
    };
  }
  return {
    icon: FaLayerGroup,
    badgeClass: 'badge-default',
    desc: 'System operational module access',
  };
};

export default function Roles({}: Props) {
  const { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo } = useToast();
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [modules, setModules] = useState<ModuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null);
  const [formData, setFormData] = useState({ name: '', moduleIds: [] as number[] });
  const [isSaving, setIsSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Delete confirm modal state
  const [deletingRole, setDeletingRole] = useState<RoleItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const [rolesRes, modsRes] = await Promise.all([
        fetch(`${API_URL}/api/v1/roles`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/v1/modules`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      if (rolesRes.ok) setRoles(await rolesRes.json());
      if (modsRes.ok) setModules(await modsRes.json());
      if (!rolesRes.ok || !modsRes.ok) {
        toastError('Failed to load complete roles and module permissions.', 'Server Error');
      }
    } catch (err) {
      console.error('Failed to load roles data:', err);
      toastError('Could not connect to server to load roles.', 'Network Error');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    const minDelay = new Promise(resolve => setTimeout(resolve, 500));
    try {
      await Promise.all([fetchData(), minDelay]);
      toastInfo('Roles and module permissions updated.', 'Refreshed');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Filtered roles based on search
  const filteredRoles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => {
      const matchName = r.name.toLowerCase().includes(q);
      const matchModules = r.roleModules?.some((rm) =>
        rm.module.name.toLowerCase().includes(q)
      );
      return matchName || matchModules;
    });
  }, [roles, searchQuery]);

  const openCreateModal = () => {
    setEditingRole(null);
    setFormData({ name: '', moduleIds: [] });
    setModalError(null);
    setShowModal(true);
  };

  const openEditModal = (role: RoleItem) => {
    setEditingRole(role);
    setFormData({
      name: role.name,
      moduleIds: role.roleModules?.map((rm) => rm.moduleId) || [],
    });
    setModalError(null);
    setShowModal(true);
  };

  const closeModal = () => {
    if (isSaving) return;
    setShowModal(false);
    setEditingRole(null);
    setModalError(null);
  };

  const toggleModule = (modId: number) => {
    setFormData((prev) => ({
      ...prev,
      moduleIds: prev.moduleIds.includes(modId)
        ? prev.moduleIds.filter((id) => id !== modId)
        : [...prev.moduleIds, modId],
    }));
  };

  const handleSelectAll = () => {
    setFormData((prev) => ({
      ...prev,
      moduleIds: modules.map((m) => m.id),
    }));
    toastInfo(`Selected all ${modules.length} modules for this role.`, 'Permissions');
  };

  const handleClearAll = () => {
    setFormData((prev) => ({
      ...prev,
      moduleIds: [],
    }));
    toastInfo('Cleared all module selections for this role.', 'Permissions');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = formData.name.trim();
    if (!trimmedName) {
      setModalError('Role name is required.');
      toastWarning('Role name is required.', 'Validation');
      return;
    }

    setIsSaving(true);
    setModalError(null);

    const isEditing = !!editingRole;
    const url = isEditing
      ? `${API_URL}/api/v1/roles/${editingRole.id}`
      : `${API_URL}/api/v1/roles`;
    const method = isEditing ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({
          name: trimmedName,
          moduleIds: formData.moduleIds,
        }),
      });

      if (res.ok) {
        setShowModal(false);
        fetchData();
        if (isEditing) {
          toastSuccess(`Role "${trimmedName}" updated with ${formData.moduleIds.length} module permissions.`, 'Role Updated');
        } else {
          toastSuccess(`Role "${trimmedName}" created with ${formData.moduleIds.length} module permissions.`, 'Role Created');
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        const msg = errorData.error || errorData.message || 'Failed to save role';
        setModalError(msg);
        toastError(msg, 'Save Failed');
      }
    } catch (err: any) {
      console.error(err);
      const msg = err.message || 'Network error while saving role';
      setModalError(msg);
      toastError(msg, 'Save Error');
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingRole) return;
    const roleNameToDelete = deletingRole.name;
    setIsDeleting(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/roles/${deletingRole.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
      });
      if (res.ok) {
        setDeletingRole(null);
        fetchData();
        toastSuccess(`Role "${roleNameToDelete}" deleted successfully.`, 'Role Deleted');
      } else {
        const err = await res.json().catch(() => ({}));
        const msg = err.error || err.message || 'Failed to delete role';
        toastError(msg, 'Delete Failed');
      }
    } catch (err) {
      console.error(err);
      toastError('Network error occurred while deleting role.', 'Delete Error');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="roles-container">
      {/* Header bar */}
      <div className="roles-header">
        <div className="roles-top-actions">
          <div className="roles-search-box">
            <FaSearch className="roles-search-icon" />
            <input
              type="text"
              className="roles-search-input"
              placeholder="Search roles or modules..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              type="button"
              className="btn-refresh-roles"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh roles from server"
            >
              <FaSyncAlt className={isRefreshing ? 'spin' : ''} />
              <span>{isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
            </button>

            <button 
              className="btn-create-role" 
              onClick={openCreateModal}
              title="Create a new system role"
              data-tooltip="Create new role"
            >
              <FaPlus />
              Create Role
            </button>
          </div>
        </div>
      </div>

      {/* Grid of Role Cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          Loading roles and permissions...
        </div>
      ) : (
        <div className="roles-grid">
          {filteredRoles.map((r) => {
            const isDev = r.name.toLowerCase() === 'developer';
            const modCount = r.roleModules?.length || 0;

            return (
              <div key={r.id} className="role-card">
                <div>
                  <div className="role-card-header">
                    <div className="role-identity">
                      <div className={`role-icon-avatar ${isDev ? 'developer' : ''}`}>
                        {isDev ? <FaCrown /> : <FaShieldAlt />}
                      </div>
                      <div>
                        <h3 className="role-name-text">{r.name}</h3>
                        {isDev && (
                          <span className="system-badge">
                            <FaLock style={{ fontSize: '0.65rem' }} /> System Role
                          </span>
                        )}
                      </div>
                    </div>

                    <span className={`modules-count-badge ${modCount > 0 ? 'has-modules' : ''}`}>
                      {modCount} {modCount === 1 ? 'Module' : 'Modules'}
                    </span>
                  </div>

                  <div className="role-modules-area">
                    <div className="role-modules-label">Allowed Modules:</div>
                    <div className="role-modules-tags">
                      {r.roleModules && r.roleModules.length > 0 ? (
                        r.roleModules.map((rm) => {
                          const meta = getModuleMeta(rm.module.name, rm.module.slug);
                          const IconComp = meta.icon;
                          return (
                            <span key={rm.moduleId} className="module-pill-tag">
                              <IconComp style={{ color: 'var(--primary)', fontSize: '0.75rem' }} />
                              {rm.module.name}
                            </span>
                          );
                        })
                      ) : (
                        <div className="no-modules-placeholder">
                          No module permissions assigned
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="role-card-footer">
                  {!isDev && (
                    <>
                      <button
                        className="btn-card-action edit"
                        onClick={() => openEditModal(r)}
                      >
                        <FaEdit /> Edit
                      </button>
                      <button
                        className="btn-card-action delete"
                        onClick={() => setDeletingRole(r)}
                      >
                        <FaTrash /> Delete
                      </button>
                    </>
                  )}
                  {isDev && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Protected system role
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {filteredRoles.length === 0 && (
            <div className="roles-empty-state">
              <FaShieldAlt className="roles-empty-icon" />
              <div className="roles-empty-title">No Roles Found</div>
              <div className="roles-empty-desc">
                {searchQuery
                  ? `No roles matching "${searchQuery}". Try a different keyword.`
                  : 'No roles have been configured in the system yet.'}
              </div>
              {searchQuery && (
                <button
                  className="btn-quick-pill"
                  onClick={() => {
                    setSearchQuery('');
                    toastInfo('Role search filter cleared.', 'Search Reset');
                  }}
                  style={{ display: 'inline-block', margin: '0 auto' }}
                >
                  Clear Search
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ====================================================================
          Create / Edit Role Modal
          ==================================================================== */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="modal-header-modern">
              <div className="modal-header-info">
                <div className="modal-header-icon">
                  <FaShieldAlt />
                </div>
                <div className="modal-header-text">
                  <h3>{editingRole ? `Edit Role: ${editingRole.name}` : 'Create New Role'}</h3>
                  <p>Assign module permissions and access control for this role.</p>
                </div>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeModal}
                aria-label="Close modal"
              >
                <FaTimes />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="modal-form-body">
                {modalError && (
                  <div
                    style={{
                      backgroundColor: 'rgba(214, 69, 69, 0.1)',
                      color: 'var(--danger)',
                      padding: '0.75rem 1rem',
                      borderRadius: '10px',
                      fontSize: '0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      border: '1px solid rgba(214, 69, 69, 0.2)',
                    }}
                  >
                    <FaExclamationTriangle />
                    <span>{modalError}</span>
                  </div>
                )}

                {/* Role Name */}
                <div className="form-group-field">
                  <label className="form-field-label">
                    <span>
                      Role Name <span className="required">*</span>
                    </span>
                  </label>
                  <div className="input-with-icon">
                    <FaTag className="input-icon-prefix" />
                    <input
                      type="text"
                      className="input-text-modern"
                      placeholder="e.g., Gatesman, Division Officer"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                      autoFocus
                    />
                  </div>
                </div>

                {/* Allowed Modules Section */}
                <div className="form-group-field" style={{ marginTop: '0.25rem' }}>
                  <div className="modules-section-bar">
                    <div className="modules-section-title-wrap">
                      <span className="form-field-label" style={{ margin: 0 }}>
                        Allowed Modules
                      </span>
                      <span className="modules-count-tag">
                        {formData.moduleIds.length} of {modules.length} Selected
                      </span>
                    </div>

                    <div className="modules-quick-actions">
                      <button
                        type="button"
                        className="btn-quick-pill"
                        onClick={handleSelectAll}
                        title="Select all modules"
                      >
                        <FaCheckDouble style={{ marginRight: '0.25rem', fontSize: '0.7rem' }} />
                        Select All
                      </button>
                      <button
                        type="button"
                        className="btn-quick-pill"
                        onClick={handleClearAll}
                        title="Clear all selected modules"
                      >
                        <FaTimesCircle style={{ marginRight: '0.25rem', fontSize: '0.7rem' }} />
                        Clear All
                      </button>
                    </div>
                  </div>

                  {/* Interactive Module Cards */}
                  <div className="modules-tiles-list">
                    {modules.map((mod) => {
                      const isSelected = formData.moduleIds.includes(mod.id);
                      const meta = getModuleMeta(mod.name, mod.slug);
                      const IconComp = meta.icon;

                      return (
                        <div
                          key={mod.id}
                          className={`module-toggle-tile ${isSelected ? 'selected' : ''}`}
                          onClick={() => toggleModule(mod.id)}
                          role="checkbox"
                          aria-checked={isSelected}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === ' ' || e.key === 'Enter') {
                              e.preventDefault();
                              toggleModule(mod.id);
                            }
                          }}
                        >
                          <div className="module-tile-left">
                            <div className={`module-tile-icon-badge ${meta.badgeClass}`}>
                              <IconComp />
                            </div>
                            <div className="module-tile-details">
                              <span className="module-tile-name">{mod.name}</span>
                              <span className="module-tile-desc">{meta.desc}</span>
                            </div>
                          </div>

                          <div className="custom-checkbox-indicator">
                            {isSelected && <FaCheck />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="modal-footer-modern">
                <p className="modal-footer-tip">
                  Permissions take effect on user login.
                </p>

                <div className="modal-footer-buttons">
                  <button
                    type="button"
                    className="btn-cancel-modal"
                    onClick={closeModal}
                    disabled={isSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn-save-modal"
                    disabled={isSaving}
                    title="Save role details"
                    data-tooltip="Save role"
                  >
                    {isSaving ? (
                      <>
                        <FaSpinner className="spin" style={{ marginRight: '0.35rem' }} /> Saving...
                      </>
                    ) : (
                      <>
                        <FaCheck style={{ marginRight: '0.35rem' }} /> Save Role
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ====================================================================
          Delete Confirmation Dialog
          ==================================================================== */}
      {deletingRole && (
        <div className="modal-overlay" onClick={() => setDeletingRole(null)}>
          <div
            className="modal-dialog"
            style={{ maxWidth: '420px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-dialog-content">
              <div className="confirm-icon-warning">
                <FaExclamationTriangle />
              </div>
              <h3 className="confirm-dialog-title">Delete Role?</h3>
              <p className="confirm-dialog-msg">
                Are you sure you want to delete role <strong>"{deletingRole.name}"</strong>?
                Users assigned to this role will lose their permission mappings.
              </p>
            </div>
            <div className="modal-footer-modern" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn-cancel-modal"
                onClick={() => setDeletingRole(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-card-action delete"
                style={{
                  padding: '0.65rem 1.3rem !important',
                  borderRadius: '10px !important',
                  backgroundColor: 'var(--danger) !important',
                  color: 'white'
                }}
                onClick={confirmDelete}
                disabled={isDeleting}
              >
                <FaTrash />
                {isDeleting ? 'Deleting...' : 'Delete Role'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
