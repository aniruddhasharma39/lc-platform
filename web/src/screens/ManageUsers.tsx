import { useEffect, useState, useMemo } from 'react';
import {
  FaUsers,
  FaUserCheck,
  FaUserSlash,
  FaUserClock,
  FaSearch,
  FaChevronDown,
  FaChevronUp,
  FaSyncAlt,
  FaSearchPlus,
  FaTimes,
  FaCheck,
  FaPhone,
  FaEnvelope,
  FaIdBadge,
  FaBuilding,
  FaVenusMars,
  FaShieldAlt,
  FaCrown,
  FaTrain,
  FaHardHat,
  FaFileImage,
  FaCopy,
  FaExclamationTriangle,
  FaSpinner,
  FaFilter,
  FaLayerGroup,
} from 'react-icons/fa';
import type { User } from '../types';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';
import './ManageUsers.css';

type Props = {
  user: User;
  onUserUpdate?: () => void;
};

interface RoleItem {
  id: number;
  name: string;
}

interface RegistrationRequestItem {
  id: number;
  formId: number;
  data: string;
  requestedRoleId?: number;
  requestedRoleName?: string;
  hasConflict?: boolean;
  conflictReasons?: string[];
  status: string;
  createdAt?: string;
  form?: {
    id: number;
    name: string;
    schema?: string;
  };
}

export default function ManageUsers({ user, onUserUpdate }: Props) {
  const [users, setUsers] = useState<any[]>([]);
  const [pendingRequests, setPendingRequests] = useState<RegistrationRequestItem[]>([]);
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Navigation & Filtering
  const [activeTab, setActiveTab] = useState<'existing' | 'pending'>('existing');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState('ALL');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState('ALL');
  const [showFilters, setShowFilters] = useState(false);

  // Accordion open state for roles (set of expanded role names)
  const [expandedRoles, setExpandedRoles] = useState<Record<string, boolean>>({});

  // Modals & Action States
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ id: number; action: 'deactivate' | 'reactivate'; name: string } | null>(null);
  const [rejectModal, setRejectModal] = useState<{ id: number; name: string } | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [actionLoading, setActionLoading] = useState<{ id: number; action: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Centralized Toast Hook
  const { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo } = useToast();

  // Selected roles for pending approvals map [requestId -> roleId]
  const [pendingRoleSelection, setPendingRoleSelection] = useState<Record<number, number>>({});

  const showToast = (message: string, type: 'success' | 'danger' | 'info' = 'success', title?: string) => {
    if (type === 'danger') toastError(message, title);
    else if (type === 'info') toastInfo(message, title);
    else toastSuccess(message, title);
  };

  const fetchAllData = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      const [usersRes, rolesRes] = await Promise.all([
        fetch(`${API_URL}/api/v1/users`, { headers }),
        fetch(`${API_URL}/api/v1/roles`, { headers }),
      ]);

      if (usersRes.ok) {
        const uData = await usersRes.json();
        setUsers(uData.users || []);
        setPendingRequests(uData.pendingRequests || []);

        // Pre-fill pending role selections based on user request
        const initialRolesMap: Record<number, number> = {};
        (uData.pendingRequests || []).forEach((req: RegistrationRequestItem) => {
          let rId = req.requestedRoleId;
          if (!rId && req.data) {
            try {
              const d = JSON.parse(req.data);
              if (d.roleId) rId = Number(d.roleId);
              else if (d.requestedRoleId) rId = Number(d.requestedRoleId);
            } catch {}
          }
          if (rId) {
            initialRolesMap[req.id] = rId;
          }
        });
        setPendingRoleSelection(prev => ({ ...initialRolesMap, ...prev }));
      }

      if (rolesRes.ok) {
        const rData = await rolesRes.json();
        if (Array.isArray(rData)) setRoles(rData);
      }
    } catch (err) {
      console.error('Error fetching users:', err);
      showToast('Failed to load user directory', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    const minDelay = new Promise(resolve => setTimeout(resolve, 500));
    try {
      await Promise.all([fetchAllData(), minDelay]);
      if (onUserUpdate) onUserUpdate();
      toastSuccess('User directory and pending approvals refreshed.', 'Directory Updated');
    } catch {
      toastError('Failed to refresh user directory. Check network connection.', 'Refresh Failed');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Humanize dictionary keys for display
  const humanizeKey = (key: string) => {
    const cleanKey = key.trim();
    const normalized = cleanKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'fullname' || normalized === 'name') return 'Full Name';
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

  const getRoleIcon = (roleName: string) => {
    const lower = (roleName || '').toLowerCase();
    if (lower.includes('developer') || lower.includes('admin')) return FaCrown;
    if (lower.includes('station') || lower.includes('section') || lower.includes('train')) return FaTrain;
    if (lower.includes('gate')) return FaHardHat;
    if (lower.includes('officer') || lower.includes('zone') || lower.includes('division')) return FaShieldAlt;
    return FaUsers;
  };

  const copyToClipboard = (text: string, identifier: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(identifier);
    toastInfo(`Copied "${text}" to clipboard!`, 'Copied');
    setTimeout(() => {
      setCopiedKey(prev => (prev === identifier ? null : prev));
    }, 2000);
  };

  // Actions: Deactivate / Reactivate / Approve / Reject
  const handleUserStatusChange = async (id: number, action: 'deactivate' | 'reactivate', userName: string) => {
    setActionLoading({ id, action });
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/users/${id}/${action}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        if (action === 'deactivate') {
          toastWarning(`User account "${userName}" has been deactivated.`, 'Account Deactivated');
        } else {
          toastSuccess(`User account "${userName}" has been reactivated successfully!`, 'Account Reactivated');
        }
        setConfirmModal(null);
        await fetchAllData();
        if (onUserUpdate) onUserUpdate();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || `Failed to ${action} user`, 'Action Failed');
      }
    } catch (err: any) {
      console.error(err);
      toastError(err.message || `Network error during ${action}`, 'Action Failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleApproveRequest = async (reqId: number, applicantName: string) => {
    const targetReq = pendingRequests.find(r => r.id === reqId);
    if (targetReq?.hasConflict) {
      toastError(`Cannot approve: ${(targetReq.conflictReasons || []).join('; ')}. Please reject this request or resolve the duplicate user first.`, 'Conflict Detected');
      return;
    }

    const roleId = pendingRoleSelection[reqId] || roles[0]?.id;
    if (!roleId) {
      toastWarning('Please select an operational role to assign before approving.', 'Role Required');
      return;
    }

    setActionLoading({ id: reqId, action: 'approve' });
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/users/request/${reqId}/approve`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ roleId: Number(roleId) }),
      });

      if (res.ok) {
        const assignedRole = roles.find(r => r.id === Number(roleId))?.name || 'Assigned Role';
        toastSuccess(`Registration approved for "${applicantName}" as ${assignedRole}! User account is now active.`, 'Application Approved');
        await fetchAllData();
        if (onUserUpdate) onUserUpdate();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to approve request', 'Approval Failed');
      }
    } catch (err: any) {
      console.error(err);
      toastError(err.message || 'Error occurred while approving request', 'Approval Failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRejectRequest = async () => {
    if (!rejectModal) return;
    const { id, name } = rejectModal;

    setActionLoading({ id, action: 'reject' });
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/users/request/${id}/reject`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: rejectionReason.trim() }),
      });

      if (res.ok) {
        const reasonMsg = rejectionReason.trim() ? ` (Reason: ${rejectionReason.trim()})` : '';
        toastInfo(`Registration request for "${name}" has been rejected${reasonMsg}.`, 'Request Rejected');
        setRejectModal(null);
        setRejectionReason('');
        await fetchAllData();
        if (onUserUpdate) onUserUpdate();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to reject request', 'Rejection Failed');
      }
    } catch (err: any) {
      console.error(err);
      toastError(err.message || 'Error occurred while rejecting request', 'Rejection Failed');
    } finally {
      setActionLoading(null);
    }
  };

  // Helper to unpack pending request registration form data
  const parseRequestData = (req: RegistrationRequestItem) => {
    let reqData: Record<string, any> = {};
    try {
      reqData = JSON.parse(req.data || '{}');
    } catch {
      reqData = {};
    }

    let schema: any = null;
    try {
      if (req.form?.schema) schema = JSON.parse(req.form.schema);
    } catch {}

    const allFields: any[] = [];
    const walk = (fields: any[]) => {
      if (!fields) return;
      for (const f of fields) {
        if (f.type === 'section' && f.children) walk(f.children);
        else allFields.push(f);
      }
    };
    if (schema?.fields) walk(schema.fields);

    let fullName = reqData.fullName || reqData.name || '';
    const textDetails: [string, any][] = [];
    const imageDetails: [string, any][] = [];
    const seenLabels = new Set<string>(['password', 'roleid', 'role_id', 'role', 'status']);
    const seenValues = new Set<string>();

    for (const [k, v] of Object.entries(reqData)) {
      if (k.toLowerCase().includes('password')) continue;
      const field = allFields.find(f => f.name === k);
      const label = field ? field.label : humanizeKey(k);
      const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (!fullName && field && field.label.toLowerCase().includes('name')) {
        fullName = v;
      }

      if (['fullname', 'name', 'applicantname'].includes(normLabel)) {
        if (!fullName) fullName = v;
        continue;
      }

      if (isImgUrl(v)) {
        imageDetails.push([label, v]);
      } else if (v !== null && v !== undefined && v !== '') {
        const strVal = String(v).trim().toLowerCase();
        if (!seenLabels.has(normLabel) && !seenValues.has(strVal)) {
          seenLabels.add(normLabel);
          seenValues.add(strVal);
          textDetails.push([label, v]);
        }
      }
    }

    let reqRoleId = req.requestedRoleId;
    if (!reqRoleId) {
      if (reqData.roleId) reqRoleId = Number(reqData.roleId);
      else if (reqData.requestedRoleId) reqRoleId = Number(reqData.requestedRoleId);
    }

    return {
      fullName: fullName || 'Applicant',
      textDetails,
      imageDetails,
      reqRoleId,
    };
  };

  // Filter existing users
  const filteredUsers = useMemo(() => {
    return users.filter(u => {
      // Role filter
      if (selectedRoleFilter !== 'ALL') {
        const rName = u.role?.name || 'Unassigned';
        if (rName !== selectedRoleFilter) return false;
      }

      // Status filter
      if (selectedStatusFilter !== 'ALL') {
        if (u.status !== selectedStatusFilter) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = (u.fullName || '').toLowerCase().includes(q);
        const emailMatch = (u.email || '').toLowerCase().includes(q);
        const mobileMatch = (u.mobile || '').toLowerCase().includes(q);
        const empMatch = (u.employeeId || '').toLowerCase().includes(q);
        const deptMatch = (u.department || '').toLowerCase().includes(q);
        const roleMatch = (u.role?.name || '').toLowerCase().includes(q);
        const metaMatch = (u.metadata || '').toLowerCase().includes(q);

        return nameMatch || emailMatch || mobileMatch || empMatch || deptMatch || roleMatch || metaMatch;
      }

      return true;
    });
  }, [users, selectedRoleFilter, selectedStatusFilter, searchQuery]);

  // Group filtered users by Role
  const usersByRole = useMemo(() => {
    const map: Record<string, any[]> = {};
    filteredUsers.forEach(u => {
      if (u.status === 'PENDING') return;
      const roleName = u.role?.name || 'Unassigned';
      if (!map[roleName]) map[roleName] = [];
      map[roleName].push(u);
    });
    return map;
  }, [filteredUsers]);

  // Role group accordion logic: All role groups are COLLAPSED by default
  // Only expand when user explicitly clicks on a role header or clicks "Expand All"
  const roleNames = useMemo(() => Object.keys(usersByRole), [usersByRole]);
  const allRolesExpanded = useMemo(() => {
    return roleNames.length > 0 && roleNames.every(rn => Boolean(expandedRoles[rn]));
  }, [roleNames, expandedRoles]);

  const toggleRoleExpanded = (roleName: string) => {
    setExpandedRoles(prev => ({
      ...prev,
      [roleName]: !prev[roleName],
    }));
  };

  const handleToggleAllAccordions = () => {
    const shouldExpandAll = !allRolesExpanded;
    const newState: Record<string, boolean> = {};
    roleNames.forEach(rn => {
      newState[rn] = shouldExpandAll;
    });
    setExpandedRoles(newState);
  };

  // Metrics
  const totalUsersCount = users.length;
  const approvedUsersCount = users.filter(u => u.status === 'APPROVED').length;
  const deactivatedUsersCount = users.filter(u => u.status === 'DEACTIVATED').length;
  const pendingCount = pendingRequests.length;

  return (
    <div className="manage-users-container">
      {/* Page Header */}
      <div className="manage-users-header">
        <div className="manage-users-title-group">
          <div className="manage-users-title-icon-badge">
            <FaUsers />
          </div>
          <div className="manage-users-title-text">
            <h2>User Management & Directory</h2>
            <p>Administer verified personnel, approve access requests, and manage system roles.</p>
          </div>
        </div>

        <div className="manage-users-top-actions">
          <button
            type="button"
            className="btn-refresh-users"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Refresh user records from database"
          >
            <FaSyncAlt className={isRefreshing ? 'spin' : ''} />
            <span>{isRefreshing ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Metric Stats Cards */}
      <div className="users-stats-grid">
        <div className="user-stat-card">
          <div className="stat-icon-wrapper blue">
            <FaUsers />
          </div>
          <div className="stat-info">
            <span className="stat-label">Total Users</span>
            <span className="stat-value">{totalUsersCount}</span>
          </div>
        </div>

        <div className="user-stat-card">
          <div className="stat-icon-wrapper green">
            <FaUserCheck />
          </div>
          <div className="stat-info">
            <span className="stat-label">Active / Approved</span>
            <span className="stat-value">{approvedUsersCount}</span>
          </div>
        </div>

        <div className="user-stat-card">
          <div className="stat-icon-wrapper red">
            <FaUserSlash />
          </div>
          <div className="stat-info">
            <span className="stat-label">Deactivated</span>
            <span className="stat-value">{deactivatedUsersCount}</span>
          </div>
        </div>

        <div className="user-stat-card">
          <div className="stat-icon-wrapper amber">
            <FaUserClock />
          </div>
          <div className="stat-info">
            <span className="stat-label">Pending Approval</span>
            <span className="stat-value">{pendingCount}</span>
          </div>
        </div>
      </div>

      {/* Navigation Toolbar & Filters */}
      <div className="users-toolbar">
        {/* Row 1: Primary Navigation Tabs & Search */}
        <div className="toolbar-top-row">
          {/* Segmented Tab Switcher */}
          <div className="users-tab-group">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'existing' ? 'active' : ''}`}
              onClick={() => setActiveTab('existing')}
            >
              <FaUsers />
              <span>Existing Users</span>
              <span className="tab-badge">{users.length}</span>
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
            >
              <FaUserClock />
              <span>Pending Requests</span>
              <span className={`tab-badge ${pendingCount > 0 ? 'pending-alert' : ''}`}>
                {pendingCount}
              </span>
            </button>
          </div>

          {/* Search & Action Controls for Existing Users */}
          {activeTab === 'existing' && (
            <div className="toolbar-top-controls-right">
              {/* Search Bar */}
              <div className="search-box-wrapper">
                <FaSearch className="search-box-icon" />
                <input
                  type="text"
                  className="search-box-input"
                  placeholder="Search by name, ID, mobile, dept..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-box-clear"
                    onClick={() => setSearchQuery('')}
                    title="Clear search query"
                    aria-label="Clear search"
                  >
                    <FaTimes />
                  </button>
                )}
              </div>

              {/* Filters Toggle Button */}
              {(() => {
                const activeCount = (selectedRoleFilter !== 'ALL' ? 1 : 0) + (selectedStatusFilter !== 'ALL' ? 1 : 0);
                const hasFilters = activeCount > 0;
                return (
                  <button
                    type="button"
                    className={`btn-toggle-filters-user ${showFilters ? 'active' : ''} ${hasFilters ? 'has-active' : ''}`}
                    onClick={() => setShowFilters(prev => !prev)}
                    title={showFilters ? 'Hide filters panel' : 'Open filter options'}
                  >
                    <FaFilter className="filter-btn-icon" />
                    <span>Filters</span>
                    {activeCount > 0 && <span className="active-filter-badge">{activeCount}</span>}
                    {showFilters ? <FaChevronUp size={10} /> : <FaChevronDown size={10} />}
                  </button>
                );
              })()}

              {/* Expand / Collapse All Roles Button */}
              {roleNames.length > 0 && (
                <button
                  type="button"
                  className="btn-toggle-all-accordions"
                  onClick={handleToggleAllAccordions}
                  title={allRolesExpanded ? 'Collapse all role groups' : 'Expand all role groups'}
                >
                  {allRolesExpanded ? <FaChevronUp size={12} /> : <FaChevronDown size={12} />}
                  <span>{allRolesExpanded ? 'Collapse All' : 'Expand All'}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Active Filters Summary Chips (When filter strip is closed but filters are active) */}
        {activeTab === 'existing' && !showFilters && (selectedRoleFilter !== 'ALL' || selectedStatusFilter !== 'ALL') && (
          <div className="active-filters-chips-strip fade-in">
            <span className="active-chips-label">Filters Applied:</span>
            {selectedRoleFilter !== 'ALL' && (
              <span className="filter-chip">
                Role: {selectedRoleFilter}
                <button type="button" onClick={() => setSelectedRoleFilter('ALL')}>✕</button>
              </span>
            )}
            {selectedStatusFilter !== 'ALL' && (
              <span className="filter-chip">
                Status: {selectedStatusFilter}
                <button type="button" onClick={() => setSelectedStatusFilter('ALL')}>✕</button>
              </span>
            )}
            <button
              type="button"
              className="btn-clear-all-chips"
              onClick={() => {
                setSelectedRoleFilter('ALL');
                setSelectedStatusFilter('ALL');
                toastInfo('Active user filters cleared. Showing all records.', 'Filters Reset');
              }}
            >
              Clear All
            </button>
          </div>
        )}

        {/* Row 2: Secondary Filter Strip: ONLY shown when user clicks Filters toggle */}
        {activeTab === 'existing' && showFilters && (
          <div className="toolbar-filter-strip fade-in">
            <div className="filter-controls-left">
              <div className="filter-label-group">
                <FaFilter className="filter-icon" />
                <span className="filter-label-text">Filter:</span>
              </div>

              {/* Role Dropdown */}
              <div className="filter-select-wrapper">
                <select
                  className="filter-select"
                  value={selectedRoleFilter}
                  onChange={(e) => setSelectedRoleFilter(e.target.value)}
                  title="Filter users by role"
                >
                  <option value="ALL">All Roles ({roles.length})</option>
                  {roles.map(r => (
                    <option key={r.id} value={r.name}>{r.name}</option>
                  ))}
                </select>
              </div>

              {/* Status Dropdown */}
              <div className="filter-select-wrapper">
                <select
                  className="filter-select"
                  value={selectedStatusFilter}
                  onChange={(e) => setSelectedStatusFilter(e.target.value)}
                  title="Filter users by account status"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="APPROVED">Approved Only</option>
                  <option value="DEACTIVATED">Deactivated Only</option>
                </select>
              </div>

              {/* Reset Filters Button */}
              {(selectedRoleFilter !== 'ALL' || selectedStatusFilter !== 'ALL') && (
                <button
                  type="button"
                  className="btn-clear-inline-filters"
                  onClick={() => {
                    setSelectedRoleFilter('ALL');
                    setSelectedStatusFilter('ALL');
                  }}
                  title="Reset all active filters"
                >
                  <FaTimes size={11} />
                  <span>Reset Filters</span>
                </button>
              )}
            </div>

            <div className="filter-controls-right">
              <button
                type="button"
                className="btn-small btn-apply-filter"
                onClick={() => setShowFilters(false)}
                style={{ padding: '0.45rem 1rem', borderRadius: '8px', cursor: 'pointer', background: 'var(--primary)', color: '#fff', border: 'none', fontWeight: 600, fontSize: '0.825rem' }}
              >
                Close Filters
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ====================================================================
          TAB 1: EXISTING USERS (GROUPED BY ROLE)
          ==================================================================== */}
      {activeTab === 'existing' && (
        <div>
          {loading ? (
            <div className="users-empty-state">
              <FaSpinner className="spin empty-state-icon" style={{ color: 'var(--primary)' }} />
              <p className="empty-state-title">Loading user directory...</p>
            </div>
          ) : Object.keys(usersByRole).length === 0 ? (
            <div className="users-empty-state">
              <FaUsers className="empty-state-icon" />
              <p className="empty-state-title">No Users Found</p>
              <p className="empty-state-desc">
                {searchQuery || selectedRoleFilter !== 'ALL' || selectedStatusFilter !== 'ALL'
                  ? 'No users match your active search or filter criteria. Try resetting filters.'
                  : 'No verified users are currently active in the platform.'}
              </p>
              {(searchQuery || selectedRoleFilter !== 'ALL' || selectedStatusFilter !== 'ALL') && (
                <button
                  type="button"
                  className="btn-modal-cancel"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedRoleFilter('ALL');
                    setSelectedStatusFilter('ALL');
                  }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          ) : (
            Object.entries(usersByRole).map(([roleName, roleUsers]) => {
              const RoleIcon = getRoleIcon(roleName);
              // Collapsed by default; only expanded when explicitly toggled to true
              const isExpanded = Boolean(expandedRoles[roleName]);

              return (
                <div key={roleName} className="role-group-section">
                  {/* Role Group Accordion Header */}
                  <div
                    className="role-group-header"
                    onClick={() => toggleRoleExpanded(roleName)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleRoleExpanded(roleName);
                      }
                    }}
                  >
                    <div className="role-group-title-left">
                      <div className="role-group-icon">
                        <RoleIcon />
                      </div>
                      <div className="role-group-title-info">
                        <span className="role-group-name">{roleName}</span>
                        <span className="role-user-count-chip">
                          {roleUsers.length} {roleUsers.length === 1 ? 'Member' : 'Members'}
                        </span>
                      </div>
                    </div>

                    <div className="role-accordion-right">
                      <span className="role-accordion-hint">
                        {isExpanded ? 'Click to collapse' : 'Click to expand'}
                      </span>
                      <div className={`role-accordion-arrow-btn ${isExpanded ? 'expanded' : ''}`}>
                        {isExpanded ? <FaChevronUp /> : <FaChevronDown />}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Role Users Cards */}
                  {isExpanded && (
                    <div className="role-group-content">
                      {roleUsers.map(u => {
                        const isSelf = u.id === user.id;
                        const isApproved = u.status === 'APPROVED';

                        // Parse metadata
                        let metadataObj: Record<string, any> = {};
                        try {
                          metadataObj = JSON.parse(u.metadata || '{}');
                        } catch {
                          metadataObj = {};
                        }

                        // Separate clean text details from image previews with deduplication
                        const textDetails: [string, any][] = [];
                        const imageDocs: [string, string][] = [];
                        const seenLabels = new Set<string>([
                          'fullname', 'name', 'applicantname',
                          'role', 'roleid', 'status', 'id', 'password'
                        ]);
                        const seenValues = new Set<string>();

                        const addDetail = (label: string, val: any) => {
                          if (val === null || val === undefined || val === '') return;
                          const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');
                          const strVal = String(val).trim().toLowerCase();
                          if (seenLabels.has(normLabel)) return;
                          if (seenValues.has(strVal)) return;

                          seenLabels.add(normLabel);
                          seenValues.add(strVal);
                          textDetails.push([label, val]);
                        };

                        // Add primary attributes (deduplicating against repeated metadata)
                        if (u.mobile) addDetail('Mobile Number', u.mobile);
                        if (u.email) addDetail('Email Address', u.email);
                        if (u.employeeId) addDetail('Employee ID', u.employeeId);
                        if (u.department) addDetail('Department', u.department);

                        const coreFields = [
                          'fullname', 'name', 'applicantname',
                          'mobile', 'mobilenumber', 'phone', 'phonenumber',
                          'email', 'emailaddress',
                          'employeeid', 'empid',
                          'department', 'dept',
                          'role', 'roleid', 'status', 'password', 'id'
                        ];

                        for (const [k, v] of Object.entries(metadataObj)) {
                          const normKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
                          if (normKey.includes('password')) continue;
                          if (normKey.startsWith('field')) continue;
                          if (coreFields.includes(normKey)) continue;

                          const label = humanizeKey(k);
                          const normLabel = label.toLowerCase().replace(/[^a-z0-9]/g, '');
                          if (coreFields.includes(normLabel)) continue;

                          if (isImgUrl(v)) {
                            imageDocs.push([label, String(v)]);
                          } else {
                            addDetail(label, v);
                          }
                        }

                        // Generate user initials
                        const initials = (u.fullName || 'User')
                          .split(' ')
                          .filter(Boolean)
                          .map((p: string) => p[0])
                          .slice(0, 2)
                          .join('');

                        return (
                          <div key={u.id} className="user-profile-card">
                            {/* Card Top Bar */}
                            <div className="user-card-top-bar">
                              <div className="user-identity-wrap">
                                <div className="user-avatar-circle">
                                  {initials || <FaUsers />}
                                </div>
                                <div className="user-identity-names">
                                  <div className="user-full-name-row">
                                    <span className="user-full-name">{u.fullName || 'Unnamed User'}</span>
                                    <span className={`status-pill ${u.status.toLowerCase()}`}>
                                      <span className="status-dot" />
                                      {u.status}
                                    </span>
                                    {isSelf && (
                                      <span className="user-meta-chip" style={{ backgroundColor: '#e0f2fe', color: '#0369a1' }}>
                                        You
                                      </span>
                                    )}
                                  </div>

                                  <div className="user-sub-tags">
                                    {u.employeeId && (
                                      <span className="user-meta-chip">
                                        <FaIdBadge /> {u.employeeId}
                                      </span>
                                    )}
                                    {u.department && (
                                      <span className="user-meta-chip">
                                        <FaBuilding /> {u.department}
                                      </span>
                                    )}
                                    {roleName && (
                                      <span className="user-meta-chip">
                                        <RoleIcon style={{ fontSize: '0.7rem' }} /> {roleName}
                                      </span>
                                    )}
                                  </div>

                                  {/* Assigned Scope Groups */}
                                  {u.scopeGroups && u.scopeGroups.length > 0 && (
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                                      {u.scopeGroups.map((sg: any) => (
                                        <span
                                          key={sg.scopeGroup?.id || sg.id}
                                          className="badge"
                                          style={{
                                            backgroundColor: sg.scopeGroup?.color || 'var(--primary)',
                                            color: 'white',
                                            fontSize: '0.72rem',
                                            padding: '2px 8px',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 4
                                          }}
                                        >
                                          <FaLayerGroup size={10} />
                                          {sg.scopeGroup?.name || sg.name}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Action Buttons */}
                              {!isSelf && (
                                <div className="user-card-actions">
                                  {isApproved ? (
                                    <button
                                      type="button"
                                      className="btn-user-action deactivate"
                                      onClick={() => setConfirmModal({ id: u.id, action: 'deactivate', name: u.fullName })}
                                      title={`Deactivate account for ${u.fullName}`}
                                      disabled={actionLoading?.id === u.id}
                                    >
                                      <FaUserSlash />
                                      <span>Deactivate</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="btn-user-action reactivate"
                                      onClick={() => setConfirmModal({ id: u.id, action: 'reactivate', name: u.fullName })}
                                      title={`Reactivate account for ${u.fullName}`}
                                      disabled={actionLoading?.id === u.id}
                                    >
                                      <FaUserCheck />
                                      <span>Reactivate</span>
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Multi-Column Details Grid */}
                            {textDetails.length > 0 && (
                              <div className="user-details-grid">
                                {textDetails.map(([label, val]) => {
                                  const displayStr = Array.isArray(val) ? val.join(', ') : String(val);
                                  const isMobileOrEmail = label.toLowerCase().includes('mobile') || label.toLowerCase().includes('email');
                                  const itemKey = `${u.id}-${label}`;

                                  return (
                                    <div key={label} className="detail-item">
                                      <div className="detail-label-row">
                                        {label.toLowerCase().includes('mobile') && <FaPhone style={{ fontSize: '0.65rem' }} />}
                                        {label.toLowerCase().includes('email') && <FaEnvelope style={{ fontSize: '0.65rem' }} />}
                                        {label.toLowerCase().includes('gender') && <FaVenusMars style={{ fontSize: '0.65rem' }} />}
                                        <span>{label}</span>
                                      </div>
                                      <div className="detail-value">
                                        <span>{displayStr}</span>
                                        {isMobileOrEmail && (
                                          <button
                                            type="button"
                                            className="btn-copy-chip"
                                            onClick={() => copyToClipboard(displayStr, itemKey)}
                                            title="Copy to clipboard"
                                          >
                                            {copiedKey === itemKey ? <FaCheck style={{ color: 'var(--success)' }} /> : <FaCopy />}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* Verification Documents & Image Attachments Gallery */}
                            {imageDocs.length > 0 && (
                              <div className="user-documents-section">
                                <div className="user-documents-title">
                                  <FaFileImage />
                                  <span>Verification Documents & Attachments ({imageDocs.length})</span>
                                </div>
                                <div className="user-documents-gallery">
                                  {imageDocs.map(([label, imgUrl]) => (
                                    <div
                                      key={label}
                                      className="document-preview-card"
                                      onClick={() => setImagePreviewUrl(imgUrl)}
                                      title={`Click to preview full ${label}`}
                                    >
                                      <div className="document-thumb-wrap">
                                        <img src={imgUrl} alt={label} className="document-thumb-img" />
                                        <div className="document-zoom-badge">
                                          <FaSearchPlus />
                                        </div>
                                      </div>
                                      <div className="document-info-wrap">
                                        <span className="document-label">{label}</span>
                                        <span className="document-hint">Click to enlarge</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ====================================================================
          TAB 2: PENDING APPROVAL REQUESTS
          ==================================================================== */}
      {activeTab === 'pending' && (
        <div className="pending-requests-list">
          {pendingRequests.length === 0 ? (
            <div className="users-empty-state">
              <FaUserCheck className="empty-state-icon" style={{ color: 'var(--success)' }} />
              <p className="empty-state-title">No Pending Requests</p>
              <p className="empty-state-desc">
                All registration requests have been processed. New registrations will automatically appear here for verification.
              </p>
            </div>
          ) : (
            pendingRequests.map(req => {
              const { fullName, textDetails, imageDetails, reqRoleId } = parseRequestData(req);
              const isApproving = actionLoading?.id === req.id && actionLoading?.action === 'approve';
              const isRejecting = actionLoading?.id === req.id && actionLoading?.action === 'reject';
              const isBusy = isApproving || isRejecting;
              const effectiveReqRoleId = reqRoleId || req.requestedRoleId;
              const reqRoleName = req.requestedRoleName || roles.find(r => r.id === effectiveReqRoleId)?.name;
              const selectedRoleId = pendingRoleSelection[req.id] || effectiveReqRoleId || roles[0]?.id;

              return (
                <div key={req.id} className="pending-request-card">
                  {/* Request Header */}
                  <div className="request-card-header">
                    <div className="user-identity-wrap">
                      <div className="user-avatar-circle" style={{ background: 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)' }}>
                        {fullName.substring(0, 2).toUpperCase()}
                      </div>
                      <div className="user-identity-names">
                        <div className="user-full-name-row">
                          <span className="user-full-name">{fullName}</span>
                          <span className="status-pill pending">
                            <span className="status-dot" />
                            Pending Review
                          </span>
                        </div>
                        <div className="user-sub-tags">
                          {reqRoleName && (
                            <span className="request-meta-badge" style={{ backgroundColor: '#eff6ff', color: '#1d4ed8', fontWeight: 600 }}>
                              <FaShieldAlt style={{ marginRight: 4 }} />
                              Requested Role: {reqRoleName}
                            </span>
                          )}
                          {req.form?.name && (
                            <span className="request-meta-badge">
                              Form: {req.form.name}
                            </span>
                          )}
                          {req.createdAt && (
                            <span className="request-meta-badge">
                              Submitted: {new Date(req.createdAt).toLocaleDateString()}
                            </span>
                          )}
                          {req.hasConflict && (
                            <span
                              className="request-meta-badge"
                              style={{ backgroundColor: '#fee2e2', color: '#b91c1c', fontWeight: 600, border: '1px solid #fca5a5' }}
                              title={(req.conflictReasons || []).join('; ')}
                            >
                              <FaExclamationTriangle style={{ marginRight: 4 }} />
                              Conflict: {(req.conflictReasons || []).join(' • ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Role Selection & Approval Actions */}
                    <div className="request-decision-panel">
                      <select
                        className="role-assign-select"
                        value={selectedRoleId}
                        onChange={(e) =>
                          setPendingRoleSelection(prev => ({
                            ...prev,
                            [req.id]: Number(e.target.value),
                          }))
                        }
                        disabled={isBusy}
                        title="Choose role to assign upon approval"
                      >
                        {roles.map(r => (
                          <option key={r.id} value={r.id}>
                            Role: {r.name}{r.id === effectiveReqRoleId ? ' (Requested)' : ''}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="btn-approve-request"
                        onClick={() => handleApproveRequest(req.id, fullName)}
                        disabled={isBusy}
                        title={`Approve registration for ${fullName}`}
                      >
                        {isApproving ? <FaSpinner className="spin" /> : <FaCheck />}
                        <span>{isApproving ? 'Approving...' : 'Approve'}</span>
                      </button>

                      <button
                        type="button"
                        className="btn-reject-request"
                        onClick={() => {
                          setRejectModal({ id: req.id, name: fullName });
                          setRejectionReason('');
                        }}
                        disabled={isBusy}
                        title={`Reject request from ${fullName}`}
                      >
                        {isRejecting ? <FaSpinner className="spin" /> : <FaTimes />}
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>

                  {/* Applicant Submitted Data Grid */}
                  {textDetails.length > 0 && (
                    <div className="user-details-grid">
                      {textDetails.map(([label, val]) => (
                        <div key={label} className="detail-item">
                          <div className="detail-label-row">
                            <span>{label}</span>
                          </div>
                          <div className="detail-value">
                            <span>{Array.isArray(val) ? val.join(', ') : String(val)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Document & Proof Verification Section */}
                  {imageDetails.length > 0 && (
                    <div className="user-documents-section">
                      <div className="user-documents-title">
                        <FaFileImage />
                        <span>Submitted Verification Documents ({imageDetails.length})</span>
                      </div>
                      <div className="user-documents-gallery">
                        {imageDetails.map(([label, imgUrl]) => (
                          <div
                            key={label}
                            className="document-preview-card"
                            onClick={() => setImagePreviewUrl(imgUrl)}
                            title={`Click to preview full ${label}`}
                          >
                            <div className="document-thumb-wrap">
                              <img src={imgUrl} alt={label} className="document-thumb-img" />
                              <div className="document-zoom-badge">
                                <FaSearchPlus />
                              </div>
                            </div>
                            <div className="document-info-wrap">
                              <span className="document-label">{label}</span>
                              <span className="document-hint">Click to inspect</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ====================================================================
          MODAL: DEACTIVATE / REACTIVATE CONFIRMATION
          ==================================================================== */}
      {confirmModal && (
        <div className="users-modal-backdrop" onClick={() => setConfirmModal(null)}>
          <div className="users-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="users-modal-header">
              <div className={`users-modal-icon-badge ${confirmModal.action === 'deactivate' ? 'danger' : 'success'}`}>
                {confirmModal.action === 'deactivate' ? <FaExclamationTriangle /> : <FaUserCheck />}
              </div>
              <h3>Confirm Account {confirmModal.action === 'deactivate' ? 'Deactivation' : 'Reactivation'}</h3>
            </div>
            <div className="users-modal-body">
              <p>
                Are you sure you want to <strong>{confirmModal.action}</strong> the account for{' '}
                <strong>"{confirmModal.name}"</strong>?
              </p>
              {confirmModal.action === 'deactivate' && (
                <p style={{ fontSize: '0.85rem', color: '#b91c1c' }}>
                  Deactivated users are immediately prevented from logging into the portal and mobile application.
                </p>
              )}
            </div>
            <div className="users-modal-footer">
              <button
                type="button"
                className="btn-modal-cancel"
                onClick={() => setConfirmModal(null)}
                disabled={actionLoading?.id === confirmModal.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn-user-action ${confirmModal.action}`}
                style={{ padding: '0.6rem 1.2rem', fontSize: '0.875rem' }}
                onClick={() => handleUserStatusChange(confirmModal.id, confirmModal.action, confirmModal.name)}
                disabled={actionLoading?.id === confirmModal.id}
              >
                {actionLoading?.id === confirmModal.id ? (
                  <>
                    <FaSpinner className="spin" /> Processing...
                  </>
                ) : (
                  <>
                    {confirmModal.action === 'deactivate' ? <FaUserSlash /> : <FaUserCheck />}
                    <span>Confirm {confirmModal.action === 'deactivate' ? 'Deactivation' : 'Reactivation'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL: REJECT REGISTRATION REASON
          ==================================================================== */}
      {rejectModal && (
        <div className="users-modal-backdrop" onClick={() => setRejectModal(null)}>
          <div className="users-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="users-modal-header">
              <div className="users-modal-icon-badge danger">
                <FaTimes />
              </div>
              <h3>Reject Registration Request</h3>
            </div>
            <div className="users-modal-body">
              <p>
                Specify the reason for rejecting registration request from <strong>"{rejectModal.name}"</strong>:
              </p>
              <textarea
                className="modal-textarea"
                placeholder="e.g. Incomplete ID card documentation, Invalid employee credentials..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                autoFocus
              />
            </div>
            <div className="users-modal-footer">
              <button
                type="button"
                className="btn-modal-cancel"
                onClick={() => setRejectModal(null)}
                disabled={actionLoading?.id === rejectModal.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-reject-request"
                onClick={handleRejectRequest}
                disabled={actionLoading?.id === rejectModal.id}
              >
                {actionLoading?.id === rejectModal.id ? <FaSpinner className="spin" /> : <FaTimes />}
                <span>Confirm Rejection</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL: FULLSCREEN LIGHTBOX FOR ATTACHMENTS
          ==================================================================== */}
      {imagePreviewUrl && (
        <div className="image-lightbox-backdrop" onClick={() => setImagePreviewUrl(null)}>
          <div className="image-lightbox-wrapper" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="btn-close-lightbox"
              onClick={() => setImagePreviewUrl(null)}
              aria-label="Close image preview"
            >
              <FaTimes />
            </button>
            <img src={imagePreviewUrl} alt="Document Preview" className="image-lightbox-img" />
          </div>
        </div>
      )}
    </div>
  );
}
