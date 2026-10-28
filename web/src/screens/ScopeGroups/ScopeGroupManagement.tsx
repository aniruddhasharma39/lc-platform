import React, { useState, useEffect, useMemo } from 'react';
import {
  FaLayerGroup,
  FaPlus,
  FaSearch,
  FaTrash,
  FaEdit,
  FaUsers,
  FaTimes,
  FaSyncAlt,
  FaMicrochip,
  FaTag,
  FaCheckDouble,
  FaLock,
  FaArrowLeft,
  FaChevronRight,
  FaSun,
  FaBolt,
  FaPlug,
  FaTrain,
  FaCogs,
  FaMapMarkerAlt,
  FaFolder,
  FaFolderOpen,
  FaFolderPlus,
  FaInfoCircle
} from 'react-icons/fa';
import type { User, ScopeGroupItem } from '../../types';
import { API_URL } from '../../config';
import { RAILWAY_ZONES, RAILWAY_DATA } from '../Cluster/railwayData';
import { useToast } from '../../context/ToastContext';
import './ScopeGroupManagement.css';

type Props = {
  user: User;
};

const COLOR_PRESETS = [
  '#0B3C7A', // Navy
  '#0e9aa7', // Teal
  '#6366f1', // Indigo
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Purple
  '#0284c7', // Sky Blue
];

const authHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
});

export default function ScopeGroupManagement({ user }: Props) {
  const { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo } = useToast();
  // If user is assigned to any scope group, or is not a developer, they are restricted to read-only scope view
  const isAssigned = Boolean(user.scopeGroups && user.scopeGroups.length > 0);
  const canManage = user.role === 'Developer' && !isAssigned;

  const [scopeGroups, setScopeGroups] = useState<ScopeGroupItem[]>([]);
  const [allGates, setAllGates] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // View Navigation: 'list' | 'group_detail' | 'gate_detail'
  const [viewMode, setViewMode] = useState<'list' | 'group_detail' | 'gate_detail'>('list');
  const [activeGroup, setActiveGroup] = useState<ScopeGroupItem | null>(null);
  const [activeGate, setActiveGate] = useState<any | null>(null);
  const [activeGateSearch, setActiveGateSearch] = useState('');
  const [activeGateLoading, setActiveGateLoading] = useState(false);

  // Zone/Division reference
  const zones = RAILWAY_ZONES;
  const divisionsByZone = RAILWAY_DATA;

  // Expandable/Collapsible state for folder groups
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<number>>(new Set());

  const toggleExpand = (groupId: number, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  // Modal State for Create / Edit
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<'details' | 'subgroups' | 'gates' | 'users'>('details');
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);

  // Form State
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formColor, setFormColor] = useState('#0B3C7A');
  const [formAllowSms, setFormAllowSms] = useState(false);
  const [formParentId, setFormParentId] = useState<number | null>(null);
  const [formSubGroupInput, setFormSubGroupInput] = useState('');
  const [formSubGroupsList, setFormSubGroupsList] = useState<string[]>([]);
  const [selectedGateIds, setSelectedGateIds] = useState<Set<number>>(new Set());
  const [selectedUserIds, setSelectedUserIds] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Gate Picker Filters
  const [gateFilterZone, setGateFilterZone] = useState('');
  const [gateFilterDivision, setGateFilterDivision] = useState('');
  const [gateSearchQuery, setGateSearchQuery] = useState('');

  // User Picker Filters
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('ALL');

  // Delete Confirmation Modal
  const [deleteConfirmGroup, setDeleteConfirmGroup] = useState<ScopeGroupItem | null>(null);

  // Dedicated Quick Cluster Assignment Modal
  const [clusterAssignModalGroup, setClusterAssignModalGroup] = useState<ScopeGroupItem | null>(null);
  const [assignGateIds, setAssignGateIds] = useState<Set<number>>(new Set());
  const [assignSaving, setAssignSaving] = useState(false);
  const [assignSearch, setAssignSearch] = useState('');
  const [assignFilterZone, setAssignFilterZone] = useState('');
  const [assignFilterDiv, setAssignFilterDiv] = useState('');

  // Dedicated Quick Create Sub-Division Modal
  const [subDivisionModalParent, setSubDivisionModalParent] = useState<ScopeGroupItem | null>(null);
  const [subDivName, setSubDivName] = useState('');
  const [subDivDesc, setSubDivDesc] = useState('');
  const [subDivColor, setSubDivColor] = useState('#0B3C7A');
  const [subDivSaving, setSubDivSaving] = useState(false);

  // Fetch Scope Groups
  const fetchScopeGroups = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/scope-groups`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setScopeGroups(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch scope groups:', err);
    }
  };

  // Fetch all Gates (unrestricted call for Developers/Admins)
  const fetchAllGates = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAllGates(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Failed to fetch gates:', err);
    }
  };

  // Fetch all Users
  const fetchAllUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/users`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const usersList = data?.users || (Array.isArray(data) ? data : []);
        setAllUsers(usersList);
      }
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
  };

  const loadInitialData = async () => {
    setLoading(true);
    if (canManage) {
      await Promise.all([fetchScopeGroups(), fetchAllGates(), fetchAllUsers()]);
    } else {
      await fetchScopeGroups();
    }
    setLoading(false);
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  // Check if a group represents a Railway Zone
  const isRailwayZone = (name: string) => {
    const lower = name.toLowerCase();
    return lower.includes('railway') || zones.some(z => lower.includes(z.toLowerCase().replace(/s$/, '')));
  };

  // Helper to determine if a group is a child Division/Subgroup under a Zone
  const isDivisionOrSubGroup = (group: ScopeGroupItem) => {
    if (group.parentId && scopeGroups.some(p => p.id === group.parentId)) {
      return true;
    }
    const gName = group.name.toLowerCase();
    for (const potentialParent of scopeGroups) {
      if (potentialParent.id === group.id) continue;
      if (isRailwayZone(potentialParent.name)) {
        const zoneDivs = divisionsByZone[potentialParent.name] || [];
        const matchesDiv = zoneDivs.some(d => gName.includes(d.toLowerCase())) ||
          gName.includes('division') ||
          gName.includes('section');
        if (matchesDiv) return true;
      }
    }
    return false;
  };

  // Helper to resolve effective parent for a group
  const resolveParent = (group: ScopeGroupItem | null): ScopeGroupItem | undefined => {
    if (!group) return undefined;
    if (group.parent) return group.parent as ScopeGroupItem;
    if (group.parentId) {
      const p = scopeGroups.find(g => g.id === group.parentId);
      if (p) return p;
    }
    const gName = group.name.toLowerCase();
    for (const zoneGroup of scopeGroups) {
      if (zoneGroup.id === group.id) continue;
      if (isRailwayZone(zoneGroup.name)) {
        const zoneDivs = divisionsByZone[zoneGroup.name] || [];
        if (zoneDivs.some(d => gName.includes(d.toLowerCase())) || gName.includes('division')) {
          return zoneGroup;
        }
      }
    }
    return undefined;
  };

  // Root Scope Groups (top-level Railway Zones only; divisions will NEVER appear at same time)
  const rootGroups = useMemo(() => {
    return scopeGroups.filter(g => !isDivisionOrSubGroup(g));
  }, [scopeGroups]);

  // Displayed Scope Groups for List View
  // When no search query: only show top-level ROOT groups (nested sub-groups appear inside parent folders)
  // When search query is entered: search across all levels and show matching groups with parent path
  const displayedGroups = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return rootGroups;
    return scopeGroups.filter(g => {
      const parentObj = resolveParent(g);
      return g.name.toLowerCase().includes(q) ||
        (g.description && g.description.toLowerCase().includes(q)) ||
        (parentObj && parentObj.name.toLowerCase().includes(q));
    });
  }, [scopeGroups, rootGroups, searchQuery]);

  // Helper to get direct children of any group from loaded scopeGroups
  const getDirectChildren = (parentId: number) => {
    const parent = scopeGroups.find(g => g.id === parentId);
    if (!parent) return [];
    const isParentZone = isRailwayZone(parent.name);
    const zoneDivs = divisionsByZone[parent.name] || [];

    return scopeGroups.filter(g => {
      if (g.id === parentId) return false;
      if (g.parentId === parentId) return true;
      if (!g.parentId && isParentZone) {
        const gName = g.name.toLowerCase();
        if (zoneDivs.some(d => gName.includes(d.toLowerCase()))) return true;
        if (gName.includes('division')) {
          const otherZones = scopeGroups.filter(z => z.id !== parentId && isRailwayZone(z.name));
          if (otherZones.length === 0) return true;
        }
      }
      return false;
    });
  };

  // Helper to get recursive gates across a group and all its descendant groups
  const getRecursiveGates = (groupId: number) => {
    const descendantIds = new Set<number>([groupId]);
    let queue = [groupId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = getDirectChildren(curr);
      children.forEach(c => {
        if (!descendantIds.has(c.id)) {
          descendantIds.add(c.id);
          queue.push(c.id);
        }
      });
    }
    const gateMap = new Map<number, any>();
    scopeGroups
      .filter(g => descendantIds.has(g.id))
      .forEach(g => {
        g.gates?.forEach(item => {
          if (!gateMap.has(item.gate.id)) {
            gateMap.set(item.gate.id, item.gate);
          }
        });
      });
    return Array.from(gateMap.values());
  };

  // Breadcrumb path for active group
  const getBreadcrumbs = (group: ScopeGroupItem | null) => {
    if (!group) return [];
    const crumbs: ScopeGroupItem[] = [];
    let curr: ScopeGroupItem | undefined = group;
    const visited = new Set<number>();
    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      crumbs.unshift(curr);
      const parent = resolveParent(curr);
      if (parent && parent.id !== curr.id) {
        curr = parent;
      } else {
        curr = undefined;
      }
    }
    return crumbs;
  };

  // Compute Aggregate Stats
  const stats = useMemo(() => {
    const totalGroups = scopeGroups.length;
    const uniqueScopedGates = new Set<number>();
    const uniqueUsersInScopes = new Set<number>();

    scopeGroups.forEach(g => {
      g.gates?.forEach(item => uniqueScopedGates.add(item.gate.id));
      g.users?.forEach(item => uniqueUsersInScopes.add(item.user.id));
    });

    return {
      totalGroups,
      rootCount: rootGroups.length,
      subGroupCount: Math.max(0, totalGroups - rootGroups.length),
      totalGates: uniqueScopedGates.size,
      totalUsers: uniqueUsersInScopes.size
    };
  }, [scopeGroups, rootGroups]);

  // Open Group Detail Page
  const handleCardClick = (group: ScopeGroupItem) => {
    setActiveGroup(group);
    setActiveGate(null);
    setActiveGateSearch('');
    setViewMode('group_detail');
  };

  // Open Gate Detail Page
  const handleGateClick = async (gate: any) => {
    setActiveGate(gate);
    setViewMode('gate_detail');
    setActiveGateLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${gate.id}`, { headers: authHeaders() });
      if (res.ok) {
        const fullGate = await res.json();
        setActiveGate(fullGate);
      }
    } catch (err) {
      console.error('Failed to fetch full gate telemetry:', err);
    } finally {
      setActiveGateLoading(false);
    }
  };

  // Back to Group Detail
  const handleBackToGroup = () => {
    setActiveGate(null);
    setViewMode('group_detail');
  };

  // Back to List
  const handleBackToList = () => {
    setActiveGroup(null);
    setActiveGate(null);
    setViewMode('list');
  };

  // Keep activeGroup synced if scopeGroups updates
  useEffect(() => {
    if (activeGroup) {
      const found = scopeGroups.find(g => g.id === activeGroup.id);
      if (found) setActiveGroup(found);
    }
  }, [scopeGroups]);

  // Filtered Gates in Active Scope Group
  const activeGroupGates = useMemo(() => {
    if (!activeGroup?.gates) return [];
    const q = activeGateSearch.toLowerCase().trim();
    if (!q) return activeGroup.gates;
    return activeGroup.gates.filter(item => {
      const g = item.gate;
      const matchName = (g.name || '').toLowerCase().includes(q);
      const matchLc = (g.lcNumber || '').toLowerCase().includes(q);
      const matchLoc = (g.locationName || '').toLowerCase().includes(q);
      const matchZone = (g.zone || '').toLowerCase().includes(q);
      const matchDiv = (g.division || '').toLowerCase().includes(q);
      return matchName || matchLc || matchLoc || matchZone || matchDiv;
    });
  }, [activeGroup, activeGateSearch]);

  // Sub-Group Builder handlers
  const handleAddSubGroup = () => {
    const trimmed = formSubGroupInput.trim();
    if (!trimmed) return;
    if (formSubGroupsList.some(s => s.toLowerCase() === trimmed.toLowerCase())) {
      setFormError(`"${trimmed}" is already queued in the sub-groups list`);
      return;
    }
    if (formName.trim() && formName.trim().toLowerCase() === trimmed.toLowerCase()) {
      setFormError('A sub-group cannot have the exact same name as its parent group');
      return;
    }
    setFormSubGroupsList(prev => [...prev, trimmed]);
    setFormSubGroupInput('');
    setFormError(null);
  };

  const handleRemoveSubGroup = (index: number) => {
    setFormSubGroupsList(prev => prev.filter((_, i) => i !== index));
  };

  // Open Create Modal
  const handleOpenCreate = (preselectedParentId?: number | null | React.MouseEvent) => {
    if (!canManage) return;
    setEditingGroupId(null);
    setFormName('');
    setFormDesc('');
    setFormColor('#0B3C7A');
    setFormAllowSms(false);
    const pId = typeof preselectedParentId === 'number' ? preselectedParentId : null;
    setFormParentId(pId);
    setSelectedGateIds(new Set());
    setSelectedUserIds(new Set());
    setFormSubGroupInput('');
    setFormSubGroupsList([]);
    setFormError(null);
    setModalTab('details');
    setIsModalOpen(true);
  };

  // Open Edit Modal
  const handleOpenEdit = (group: ScopeGroupItem) => {
    if (!canManage) return;
    setEditingGroupId(group.id);
    setFormName(group.name);
    setFormDesc(group.description || '');
    setFormColor(group.color || '#0B3C7A');
    setFormAllowSms(Boolean(group.allowSms));
    setFormParentId(group.parentId ?? null);
    setSelectedGateIds(new Set(group.gates?.map(g => g.gate.id) || []));
    setSelectedUserIds(new Set(group.users?.map(u => u.user.id) || []));
    setFormSubGroupInput('');
    setFormSubGroupsList([]);
    setFormError(null);
    setModalTab('details');
    setIsModalOpen(true);
  };

  // Filtered Gates in Picker
  const pickerFilteredGates = useMemo(() => {
    return allGates.filter(gate => {
      if (gateFilterZone && gate.zone !== gateFilterZone) return false;
      if (gateFilterDivision && gate.division !== gateFilterDivision) return false;
      if (gateSearchQuery) {
        const q = gateSearchQuery.toLowerCase();
        const matchName = (gate.name || '').toLowerCase().includes(q);
        const matchLc = (gate.lcNumber || '').toLowerCase().includes(q);
        const matchLoc = (gate.locationName || '').toLowerCase().includes(q);
        if (!matchName && !matchLc && !matchLoc) return false;
      }
      return true;
    });
  }, [allGates, gateFilterZone, gateFilterDivision, gateSearchQuery]);

  // Available Divisions for selected zone in Picker
  const availableDivisions = useMemo(() => {
    if (!gateFilterZone) return [];
    return divisionsByZone[gateFilterZone] || [];
  }, [gateFilterZone, divisionsByZone]);

  // Toggle Single Gate
  const toggleGateSelection = (gateId: number) => {
    setSelectedGateIds(prev => {
      const next = new Set(prev);
      if (next.has(gateId)) next.delete(gateId);
      else next.add(gateId);
      return next;
    });
  };

  // Select / Deselect All Filtered Gates
  const selectAllFilteredGates = () => {
    setSelectedGateIds(prev => {
      const next = new Set(prev);
      pickerFilteredGates.forEach(g => next.add(g.id));
      return next;
    });
    toastInfo(`Selected all ${pickerFilteredGates.length} filtered gates.`, 'Gates Selected');
  };

  const deselectAllFilteredGates = () => {
    setSelectedGateIds(prev => {
      const next = new Set(prev);
      pickerFilteredGates.forEach(g => next.delete(g.id));
      return next;
    });
    toastInfo(`Deselected ${pickerFilteredGates.length} filtered gates.`, 'Gates Deselected');
  };

  // Open Quick Cluster Assignment Modal
  const handleOpenAssignClusters = (group: ScopeGroupItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setClusterAssignModalGroup(group);
    const existing = new Set(group.gates?.map(g => g.gate.id) || []);
    setAssignGateIds(existing);
    setAssignSearch('');
    setAssignFilterZone('');
    setAssignFilterDiv('');
  };

  // Toggle Cluster Selection in Quick Modal
  const toggleAssignGate = (gateId: number) => {
    setAssignGateIds(prev => {
      const next = new Set(prev);
      if (next.has(gateId)) next.delete(gateId);
      else next.add(gateId);
      return next;
    });
  };

  // Save Cluster Assignments
  const handleSaveClusterAssignments = async () => {
    if (!clusterAssignModalGroup) return;
    setAssignSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/scope-groups/${clusterAssignModalGroup.id}/gates`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ gateIds: Array.from(assignGateIds) })
      });
      if (res.ok) {
        const updated = await res.json();
        toastSuccess(`Assigned ${assignGateIds.size} clusters to "${clusterAssignModalGroup.name}"!`, 'Clusters Assigned');
        setClusterAssignModalGroup(null);
        await fetchScopeGroups();
        if (activeGroup && activeGroup.id === clusterAssignModalGroup.id) {
          setActiveGroup(updated);
        }
      } else {
        const err = await res.json();
        toastError(err.error || 'Failed to assign clusters', 'Assignment Error');
      }
    } catch (err: any) {
      toastError(err.message || 'Error communicating with server', 'Network Error');
    } finally {
      setAssignSaving(false);
    }
  };

  // Filtered Gates for Quick Assign Modal
  const assignFilteredGates = useMemo(() => {
    return allGates.filter(gate => {
      if (assignFilterZone && gate.zone !== assignFilterZone) return false;
      if (assignFilterDiv && gate.division !== assignFilterDiv) return false;
      if (assignSearch.trim()) {
        const q = assignSearch.toLowerCase();
        const matchName = (gate.name || '').toLowerCase().includes(q);
        const matchLc = (gate.lcNumber || '').toLowerCase().includes(q);
        const matchLoc = (gate.locationName || '').toLowerCase().includes(q);
        if (!matchName && !matchLc && !matchLoc) return false;
      }
      return true;
    });
  }, [allGates, assignFilterZone, assignFilterDiv, assignSearch]);

  const selectAllAssignFilteredGates = () => {
    setAssignGateIds(prev => {
      const next = new Set(prev);
      assignFilteredGates.forEach(g => next.add(g.id));
      return next;
    });
  };

  const deselectAllAssignFilteredGates = () => {
    setAssignGateIds(prev => {
      const next = new Set(prev);
      assignFilteredGates.forEach(g => next.delete(g.id));
      return next;
    });
  };

  // Open Create Sub-Division Modal
  const handleOpenCreateSubDivision = (parentGroup: ScopeGroupItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSubDivisionModalParent(parentGroup);
    setSubDivName('');
    setSubDivDesc(`Sub-division of ${parentGroup.name}`);
    setSubDivColor(parentGroup.color || '#0B3C7A');
  };

  // Save Sub-Division
  const handleSaveSubDivision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subDivisionModalParent || !subDivName.trim()) return;
    setSubDivSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/scope-groups`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          name: subDivName.trim(),
          description: subDivDesc.trim() || undefined,
          color: subDivColor,
          parentId: subDivisionModalParent.id,
          gateIds: [],
          userIds: [],
          subGroupNames: []
        })
      });
      if (res.ok) {
        const created = await res.json();
        toastSuccess(`Sub-division "${created.name}" created under "${subDivisionModalParent.name}"!`, 'Sub-Division Created');
        setSubDivisionModalParent(null);
        await fetchScopeGroups();
      } else {
        const err = await res.json();
        toastError(err.error || 'Failed to create sub-division', 'Error');
      }
    } catch (err: any) {
      toastError(err.message || 'Error creating sub-division', 'Error');
    } finally {
      setSubDivSaving(false);
    }
  };

  // Filtered Users in Picker
  const pickerFilteredUsers = useMemo(() => {
    return allUsers.filter(u => {
      if (userRoleFilter !== 'ALL' && u.role?.name !== userRoleFilter) return false;
      if (userSearchQuery) {
        const q = userSearchQuery.toLowerCase();
        const matchName = (u.fullName || '').toLowerCase().includes(q);
        const matchEmail = (u.email || '').toLowerCase().includes(q);
        const matchEmp = (u.employeeId || '').toLowerCase().includes(q);
        const matchDept = (u.department || '').toLowerCase().includes(q);
        if (!matchName && !matchEmail && !matchEmp && !matchDept) return false;
      }
      return true;
    });
  }, [allUsers, userRoleFilter, userSearchQuery]);

  // Available Roles for Filter
  const userRolesList = useMemo(() => {
    const roles = new Set<string>();
    allUsers.forEach(u => {
      if (u.role?.name) roles.add(u.role.name);
    });
    return Array.from(roles);
  }, [allUsers]);

  // Toggle Single User
  const toggleUserSelection = (userId: number) => {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // Submit Create or Edit Form
  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) return;
    if (!formName.trim()) {
      setFormError('Please enter a Scope Group name');
      toastWarning('Please enter a Scope Group name.', 'Validation');
      setModalTab('details');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    const isEditing = Boolean(editingGroupId);
    const trimmedName = formName.trim();
    const payload = {
      name: trimmedName,
      description: formDesc.trim() || null,
      color: formColor,
      allowSms: formAllowSms,
      parentId: formParentId,
      gateIds: Array.from(selectedGateIds),
      userIds: Array.from(selectedUserIds),
      subGroupNames: formSubGroupsList
    };

    try {
      const url = editingGroupId
        ? `${API_URL}/api/v1/scope-groups/${editingGroupId}`
        : `${API_URL}/api/v1/scope-groups`;
      const method = editingGroupId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save scope group');
      }

      setIsModalOpen(false);
      await fetchScopeGroups();
      if (isEditing) {
        toastSuccess(`Scope Group "${trimmedName}" updated successfully.`, 'Group Updated');
      } else {
        toastSuccess(`Scope Group "${trimmedName}" created with ${selectedGateIds.size} gates and ${selectedUserIds.size} users.`, 'Group Created');
      }
    } catch (err: any) {
      const msg = err.message || 'Error occurred while saving scope group';
      setFormError(msg);
      toastError(msg, 'Save Error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete Scope Group
  const handleDeleteGroup = async () => {
    if (!deleteConfirmGroup) return;
    const groupName = deleteConfirmGroup.name;
    try {
      const res = await fetch(`${API_URL}/api/v1/scope-groups/${deleteConfirmGroup.id}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        setDeleteConfirmGroup(null);
        await fetchScopeGroups();
        toastSuccess(`Scope Group "${groupName}" deleted successfully.`, 'Group Deleted');
      } else {
        const data = await res.json().catch(() => ({}));
        toastError(data.error || 'Failed to delete scope group', 'Delete Failed');
      }
    } catch (err: any) {
      console.error(err);
      toastError(err.message || 'Network error while deleting scope group.', 'Delete Error');
    }
  };

  return (
    <div className="sg-container">
      {/* 1. SCOPE GROUPS LIST VIEW */}
      {viewMode === 'list' && (
        <>
          {/* Header */}
          <div className="sg-header">
            <div className="sg-header-titles">
              <h2>
                <FaLayerGroup /> {canManage ? 'Scope Groups Console' : 'My Assigned Scope Groups'}
              </h2>
              <p>
                {canManage
                  ? 'Create granular access groups. Manually assign specific clusters & LC gates to designated team members.'
                  : 'View the scope groups and LC gates assigned to your account. Your operational access is restricted to these gates.'}
              </p>
            </div>
            {canManage ? (
              <button className="btn btn-primary" onClick={handleOpenCreate}>
                <FaPlus /> Create Scope Group
              </button>
            ) : (
              <div className="sg-readonly-badge">
                <FaLock style={{ color: '#0B3C7A' }} /> Assigned Member • Read-Only
              </div>
            )}
          </div>

          {/* Stats Cards */}
          <div className="sg-stats-grid">
            <div className="sg-stat-card">
              <div className="sg-stat-icon primary">
                <FaLayerGroup />
              </div>
              <div className="sg-stat-info">
                <h3>{stats.totalGroups}</h3>
                <span>Total Scope Groups</span>
              </div>
            </div>

            <div className="sg-stat-card">
              <div className="sg-stat-icon teal">
                <FaMicrochip />
              </div>
              <div className="sg-stat-info">
                <h3>{stats.totalGates}</h3>
                <span>Unique Scoped Gates</span>
              </div>
            </div>

            {canManage && (
              <div className="sg-stat-card">
                <div className="sg-stat-icon amber">
                  <FaUsers />
                </div>
                <div className="sg-stat-info">
                  <h3>{stats.totalUsers}</h3>
                  <span>Assigned Users</span>
                </div>
              </div>
            )}
          </div>

          {/* Toolbar */}
          <div className="sg-toolbar">
            <div className="sg-search-box">
              <FaSearch color="#94a3b8" />
              <input
                type="text"
                placeholder="Search scope groups by name or description..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    toastInfo('Scope group search filter cleared.', 'Search Reset');
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}
                >
                  <FaTimes />
                </button>
              )}
            </div>

            <button
              className="btn btn-secondary"
              onClick={async () => {
                await loadInitialData();
                toastInfo('Scope groups catalog and assignments updated.', 'Refreshed');
              }}
              title="Refresh data"
            >
              <FaSyncAlt /> Refresh
            </button>
          </div>

          {/* Groups Grid */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
              <FaSyncAlt className="spin" size={32} style={{ marginBottom: 12, color: 'var(--primary)' }} />
              <div>Loading scope groups...</div>
            </div>
          ) : displayedGroups.length === 0 ? (
            <div className="sg-empty-state">
              <FaLayerGroup className="sg-empty-icon" />
              <h3 style={{ margin: '0 0 8px 0', color: '#1e293b' }}>
                {searchQuery
                  ? 'No scope groups match your search'
                  : canManage
                  ? 'No Scope Groups Created Yet'
                  : 'No Scope Groups Assigned'}
              </h3>
              <p style={{ margin: '0 0 18px 0', maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>
                {searchQuery
                  ? 'Try adjusting your search keywords.'
                  : canManage
                  ? 'Create your first Scope Group to manually bundle LC Gates and assign them to specific users.'
                  : 'No scope groups are currently assigned to your account. Please contact an administrator to get access.'}
              </p>
              {!searchQuery && canManage && (
                <button className="btn btn-primary" onClick={handleOpenCreate}>
                  <FaPlus /> Create Your First Scope Group
                </button>
              )}
            </div>
          ) : (
            <div className="sg-groups-grid">
              {displayedGroups.map(group => {
                const childSubGroups = getDirectChildren(group.id);
                const directGateCount = group.gates?.length || group._count?.gates || 0;
                const recursiveGates = getRecursiveGates(group.id);
                const userCount = group.users?.length || group._count?.users || 0;
                const isExpanded = expandedGroupIds.has(group.id);
                const previewGates = group.gates?.slice(0, 4) || [];
                const remainingGates = directGateCount - previewGates.length;

                return (
                  <div
                    key={group.id}
                    className="sg-group-card sg-clickable-card"
                    onClick={() => handleCardClick(group)}
                    title="Click to view included gates and devices"
                  >
                    <div
                      className="sg-card-stripe"
                      style={{ backgroundColor: group.color || '#0B3C7A' }}
                    />

                    <div className="sg-card-top">
                      <div className="sg-card-top-main">
                        {(() => {
                          const p = resolveParent(group);
                          return p ? (
                            <div style={{ marginBottom: 6 }}>
                              <span className="sg-level-badge child">
                                <FaFolder size={11} /> {p.name} /
                              </span>
                            </div>
                          ) : (
                            <div style={{ marginBottom: 6 }}>
                              <span className="sg-level-badge root">
                                <FaLayerGroup size={11} /> Railway Zone (Main Scope)
                              </span>
                            </div>
                          );
                        })()}
                        <h3 className="sg-card-title">{group.name}</h3>
                      </div>

                      {canManage && (
                        <div className="sg-card-header-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className="sg-icon-btn edit"
                            onClick={() => handleOpenEdit(group)}
                            title="Edit scope group"
                          >
                            <FaEdit size={13} />
                          </button>
                          <button
                            type="button"
                            className="sg-icon-btn delete"
                            onClick={() => setDeleteConfirmGroup(group)}
                            title="Delete scope group"
                          >
                            <FaTrash size={12} />
                          </button>
                        </div>
                      )}
                    </div>

                    <p className="sg-card-desc">
                      {group.description ? (
                        group.description
                      ) : (
                        <span className="sg-card-empty-desc">No description provided.</span>
                      )}
                    </p>

                    <div className="sg-card-meta">
                      <span className="sg-pill gates">
                        <FaMicrochip /> {directGateCount} {directGateCount === 1 ? 'Gate' : 'Gates'}
                      </span>
                      {childSubGroups.length > 0 && (
                        <button
                          type="button"
                          className="sg-pill"
                          style={{
                            background: '#ede9fe',
                            color: '#6d28d9',
                            borderColor: '#ddd6fe',
                            cursor: 'pointer'
                          }}
                          onClick={(e) => toggleExpand(group.id, e)}
                          title="Click to expand/collapse nested sub-groups"
                        >
                          <FaFolderPlus /> {childSubGroups.length} {childSubGroups.length === 1 ? 'Sub-Division' : 'Sub-Divisions'} {isExpanded ? '▴' : '▾'}
                        </button>
                      )}
                      {canManage && (
                        <span className="sg-pill users">
                          <FaUsers /> {userCount} {userCount === 1 ? 'User' : 'Users'}
                        </span>
                      )}
                    </div>

                    {/* Expandable/Collapsible Sub-Groups Section right inside the card */}
                    {childSubGroups.length > 0 && (
                      <div
                        className="sg-card-folder-toggle"
                        onClick={(e) => toggleExpand(group.id, e)}
                        title={isExpanded ? 'Click to collapse nested folders' : 'Click to expand nested folders'}
                      >
                        <div className="sg-folder-toggle-left">
                          {isExpanded ? <FaFolderOpen color="#6366f1" /> : <FaFolder color="#6366f1" />}
                          <span>
                            <strong>{childSubGroups.length}</strong> {childSubGroups.length === 1 ? 'Sub-Group' : 'Sub-Groups'} ({recursiveGates.length} total gates)
                          </span>
                        </div>
                        <span className="sg-folder-toggle-indicator">
                          {isExpanded ? 'Collapse ▴' : 'Expand Folder ▾'}
                        </span>
                      </div>
                    )}

                    {isExpanded && childSubGroups.length > 0 && (
                      <div className="sg-nested-subgroups-drawer" onClick={(e) => e.stopPropagation()}>
                        <div className="sg-drawer-header">
                          <span className="sg-drawer-title">
                            <FaFolderOpen color="#6366f1" /> Sub-Divisions in {group.name}
                          </span>
                          {canManage && (
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenCreate(group.id);
                              }}
                              title={`Create a sub-group directly in ${group.name}`}
                              style={{ color: '#0B3C7A' }}
                            >
                              <FaPlus /> Sub-Group
                            </button>
                          )}
                        </div>

                        <div className="sg-nested-subgroups-list">
                          {childSubGroups.map(child => {
                            const grandChildren = getDirectChildren(child.id);
                            const childGateCount = child.gates?.length || child._count?.gates || 0;
                            const childPreviewGates = child.gates?.slice(0, 3) || [];
                            const isChildExpanded = expandedGroupIds.has(child.id);

                            return (
                              <div
                                key={child.id}
                                className="sg-nested-subgroup-card"
                                onClick={() => handleCardClick(child)}
                              >
                                <div className="sg-nested-card-top">
                                  <div className="sg-nested-card-left">
                                    <span
                                      className="sg-folder-icon-circle"
                                      style={{
                                        backgroundColor: `${child.color || group.color || '#0B3C7A'}15`,
                                        color: child.color || group.color || '#0B3C7A'
                                      }}
                                    >
                                      <FaFolder />
                                    </span>
                                    <div>
                                      <h4 className="sg-nested-card-title">{child.name}</h4>
                                      {child.description && (
                                        <p className="sg-nested-card-desc">{child.description}</p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="sg-nested-card-badges">
                                    <span className="sg-pill gates">
                                      <FaMicrochip size={10} /> {childGateCount} {childGateCount === 1 ? 'Gate' : 'Gates'}
                                    </span>
                                    {grandChildren.length > 0 && (
                                      <button
                                        type="button"
                                        className="sg-pill"
                                        style={{ background: '#ede9fe', color: '#6d28d9', cursor: 'pointer', border: 'none' }}
                                        onClick={(e) => toggleExpand(child.id, e)}
                                      >
                                        <FaFolderPlus size={10} /> {grandChildren.length} Sub {isChildExpanded ? '▴' : '▾'}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* Child Gate Chips Preview */}
                                {childGateCount > 0 && (
                                  <div className="sg-nested-preview-chips">
                                    {childPreviewGates.map(item => (
                                      <span key={item.gate.id} className="sg-gate-chip">
                                        {item.gate.lcNumber}
                                      </span>
                                    ))}
                                    {childGateCount > childPreviewGates.length && (
                                      <span className="sg-more-chip">+{childGateCount - childPreviewGates.length}</span>
                                    )}
                                  </div>
                                )}

                                {/* GrandChildren (Subgroup within Subgroup) */}
                                {isChildExpanded && grandChildren.length > 0 && (
                                  <div className="sg-grandchild-drawer" onClick={e => e.stopPropagation()}>
                                    <div style={{ fontSize: '0.74rem', fontWeight: 700, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <FaFolderOpen size={11} color="#8b5cf6" /> Sub-Units in {child.name}:
                                    </div>
                                    {grandChildren.map(gc => (
                                      <div
                                        key={gc.id}
                                        className="sg-grandchild-item"
                                        onClick={() => handleCardClick(gc)}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <FaFolder size={11} color="#8b5cf6" />
                                          <strong>{gc.name}</strong>
                                        </div>
                                        <span className="sg-pill gates" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>
                                          {gc.gates?.length || gc._count?.gates || 0} Gates
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Child Card Footer Actions */}
                                <div className="sg-nested-card-footer" onClick={e => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="sg-nested-open-btn"
                                    onClick={() => handleCardClick(child)}
                                  >
                                    <span>Open Sub-Division</span>
                                    <FaChevronRight size={10} />
                                  </button>
                                  {canManage && (
                                    <div className="sg-nested-actions-group">
                                      <button
                                        type="button"
                                        className="btn btn-xs btn-primary"
                                        onClick={(e) => handleOpenAssignClusters(child, e)}
                                        title={`Assign clusters directly to ${child.name}`}
                                      >
                                        <FaMicrochip size={10} /> + Clusters
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-xs btn-secondary"
                                        onClick={(e) => handleOpenCreateSubDivision(child, e)}
                                        title={`Add sub-group inside ${child.name}`}
                                      >
                                        <FaPlus size={10} /> Sub-Group
                                      </button>
                                      <button
                                        type="button"
                                        className="sg-icon-btn edit mini"
                                        onClick={() => handleOpenEdit(child)}
                                        title="Edit sub-group"
                                      >
                                        <FaEdit size={11} />
                                      </button>
                                      <button
                                        type="button"
                                        className="sg-icon-btn delete mini"
                                        onClick={() => setDeleteConfirmGroup(child)}
                                        title="Delete sub-group"
                                      >
                                        <FaTrash size={10} />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Direct Gate Preview for this card */}
                    <div className="sg-gates-preview">
                      <div className="sg-preview-header">
                        <span className="sg-preview-label">DIRECT INCLUDED GATES</span>
                        {directGateCount > 0 && (
                          <span className="sg-preview-badge">{directGateCount}</span>
                        )}
                      </div>
                      {directGateCount === 0 ? (
                        <div className="sg-empty-gates-hint">
                          {childSubGroups.length > 0
                            ? 'Assigned via sub-divisions above'
                            : 'No clusters assigned directly'}
                        </div>
                      ) : (
                        <div className="sg-preview-chips">
                          {previewGates.map(item => (
                            <span key={item.gate.id} className="sg-gate-chip">
                              <span className="sg-chip-dot" />
                              <span className="sg-chip-num">{item.gate.lcNumber}</span>
                              {item.gate.locationName && (
                                <span className="sg-chip-loc">({item.gate.locationName})</span>
                              )}
                            </span>
                          ))}
                          {remainingGates > 0 && (
                            <span className="sg-more-chip">+{remainingGates} more</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Organized Card Footer */}
                    <div className="sg-card-footer" onClick={(e) => e.stopPropagation()}>
                      {/* Primary Navigation Button */}
                      <button
                        type="button"
                        className="sg-view-btn"
                        onClick={() => handleCardClick(group)}
                        title={`View all LC gates and details for ${group.name}`}
                      >
                        <span className="sg-view-btn-left">
                          <FaFolderOpen size={13} />
                          <span>View Scope Group & Gates ({directGateCount})</span>
                        </span>
                        <FaChevronRight size={11} className="sg-chevron-icon" />
                      </button>

                      {/* Admin Operational Actions: Balanced side-by-side buttons */}
                      {canManage && (
                        <div className="sg-card-action-bar">
                          <button
                            type="button"
                            className="sg-btn-action primary"
                            onClick={(e) => handleOpenAssignClusters(group, e)}
                            title="Assign clusters directly to this Scope Group"
                          >
                            <FaMicrochip size={12} />
                            <span>Assign Clusters</span>
                          </button>
                          <button
                            type="button"
                            className="sg-btn-action secondary"
                            onClick={(e) => handleOpenCreateSubDivision(group, e)}
                            title="Create a child Sub-Division inside this Scope Group"
                          >
                            <FaPlus size={11} />
                            <span>Sub-Division</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 2. DEDICATED SCOPE GROUP DETAIL PAGE */}
      {viewMode === 'group_detail' && activeGroup && (
        <div className="sg-group-detail-view fade-in">
          {/* Breadcrumb Bar */}
          <div className="sg-view-header">
            <div className="sg-breadcrumb-bar">
              <button className="btn btn-secondary btn-sm" onClick={handleBackToList}>
                <FaArrowLeft /> Back
              </button>
              <span className="sg-breadcrumb-crumb" onClick={handleBackToList}>Scope Groups</span>
              {getBreadcrumbs(activeGroup).map((crumb, idx, arr) => (
                <React.Fragment key={crumb.id}>
                  <span className="sg-breadcrumb-sep">/</span>
                  {idx === arr.length - 1 ? (
                    <span className="sg-breadcrumb-active">{crumb.name}</span>
                  ) : (
                    <span
                      className="sg-breadcrumb-crumb"
                      onClick={() => {
                        setActiveGroup(crumb);
                        setActiveGate(null);
                        setActiveGateSearch('');
                      }}
                    >
                      {crumb.name}
                    </span>
                  )}
                </React.Fragment>
              ))}
            </div>
            {canManage && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleOpenEdit(activeGroup)}>
                  <FaEdit /> Edit Details
                </button>
              </div>
            )}
          </div>

          {/* Group Hero Card */}
          <div className="sg-group-hero">
            <div className="sg-hero-stripe" style={{ backgroundColor: activeGroup.color || '#0B3C7A' }} />
            <div className="sg-hero-body">
              <div className="sg-hero-title-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="sg-color-dot" style={{ backgroundColor: activeGroup.color || '#0B3C7A' }} />
                  <div>
                    {resolveParent(activeGroup) && (
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 4, background: '#f1f5f9', padding: '2px 8px', borderRadius: 4 }}>
                          <FaFolder size={11} color="#64748b" /> {resolveParent(activeGroup)?.name} /
                        </span>
                      </div>
                    )}
                    <h2 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 800, color: '#0f172a' }}>
                      {activeGroup.name}
                    </h2>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="sg-pill gates">
                    <FaMicrochip /> {activeGroup.gates?.length || 0} Direct {activeGroup.gates?.length === 1 ? 'Gate' : 'Gates'}
                  </span>
                  {getDirectChildren(activeGroup.id).length > 0 && (
                    <span className="sg-pill" style={{ background: '#ede9fe', color: '#6d28d9', borderColor: '#ddd6fe' }}>
                      <FaFolderPlus /> {getDirectChildren(activeGroup.id).length} Sub-Divisions
                    </span>
                  )}
                  {activeGroup.allowSms && (
                    <span className="sg-pill" style={{ background: '#ecfdf5', color: '#047857', borderColor: '#a7f3d0' }}>
                      📱 SMS Alerts Enabled
                    </span>
                  )}
                </div>
              </div>

              <p className="sg-hero-desc">
                {activeGroup.description || 'No description provided for this scope group.'}
              </p>

              {/* Hardware Metrics Summary */}
              <div className="sg-hero-stats">
                <div className="sg-hero-stat-item">
                  <span className="sg-hero-stat-val">{activeGroup.gates?.length || 0}</span>
                  <span className="sg-hero-stat-lbl">Direct LC Gates</span>
                </div>
                <div className="sg-hero-stat-item">
                  <span className="sg-hero-stat-val">{getRecursiveGates(activeGroup.id).length}</span>
                  <span className="sg-hero-stat-lbl">Total Hierarchy Gates</span>
                </div>
                <div className="sg-hero-stat-item">
                  <span className="sg-hero-stat-val">
                    {activeGroup.gates?.reduce((acc, g) => acc + (g.gate.masters?.length || 0), 0) || 0}
                  </span>
                  <span className="sg-hero-stat-lbl">Connected Masters</span>
                </div>
                <div className="sg-hero-stat-item">
                  <span className="sg-hero-stat-val">
                    {activeGroup.gates?.reduce(
                      (acc, g) =>
                        acc +
                        (g.gate.masters?.reduce((mAcc, m) => mAcc + (m.childDevices?.length || 0), 0) || 0),
                      0
                    ) || 0}
                  </span>
                  <span className="sg-hero-stat-lbl">Total Slave Devices</span>
                </div>
              </div>
            </div>
          </div>

          {/* Sub-Divisions & Child Folders Section */}
          {(() => {
            const activeChildren = getDirectChildren(activeGroup.id);
            return (
              <div className="sg-subgroups-section">
                <div className="sg-section-header" style={{ marginBottom: 14 }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', fontWeight: 700, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <FaFolderOpen style={{ color: activeGroup.color || '#0B3C7A' }} />
                      Sub-Divisions & Child Folders ({activeChildren.length})
                    </h3>
                    <p style={{ margin: 0, fontSize: '0.88rem', color: '#64748b' }}>
                      Scope groups nested inside {activeGroup.name}. Users assigned to {activeGroup.name} automatically have access to all clusters inside these sub-divisions.
                    </p>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={(e) => handleOpenCreateSubDivision(activeGroup, e)}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <FaPlus /> Sub-Division
                    </button>
                  )}
                </div>

                {activeChildren.length === 0 ? (
                  <div className="sg-subgroups-empty">
                    <FaFolder style={{ color: '#94a3b8', fontSize: '1.4rem' }} />
                    <span>No nested sub-divisions in this scope group yet.</span>
                  </div>
                ) : (
                  <div className="sg-nested-subgroups-grid">
                    {activeChildren.map(child => {
                      const childGateCount = child.gates?.length || child._count?.gates || 0;
                      const childGrandChildren = getDirectChildren(child.id);
                      const childPreview = child.gates?.slice(0, 3) || [];
                      return (
                        <div
                          key={child.id}
                          className="sg-subdivision-card"
                          onClick={() => {
                            setActiveGroup(child);
                            setActiveGate(null);
                            setActiveGateSearch('');
                          }}
                        >
                          <div className="sg-subdivision-header">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="sg-folder-icon-circle" style={{ backgroundColor: `${child.color || activeGroup.color || '#0B3C7A'}15`, color: child.color || activeGroup.color || '#0B3C7A' }}>
                                <FaFolder />
                              </span>
                              <strong style={{ fontSize: '1.02rem', color: '#0f172a' }}>{child.name}</strong>
                            </div>
                            <span className="sg-pill gates">
                              <FaMicrochip size={11} /> {childGateCount} Gates
                            </span>
                          </div>
                          <p style={{ margin: '6px 0 10px 0', fontSize: '0.82rem', color: '#64748b' }}>
                            {child.description || 'No description provided.'}
                          </p>
                          {childPreview.length > 0 && (
                            <div className="sg-nested-preview-chips" style={{ marginBottom: 8 }}>
                              {childPreview.map(item => (
                                <span key={item.gate.id} className="sg-gate-chip">
                                  {item.gate.lcNumber}
                                </span>
                              ))}
                              {childGateCount > childPreview.length && (
                                <span className="sg-more-chip">+{childGateCount - childPreview.length}</span>
                              )}
                            </div>
                          )}
                          {childGrandChildren.length > 0 && (
                            <div style={{ fontSize: '0.78rem', color: '#6d28d9', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
                              <FaFolderPlus size={11} /> {childGrandChildren.length} Nested Sub-Unit{childGrandChildren.length > 1 ? 's' : ''}
                            </div>
                          )}
                          <div className="sg-subdivision-footer" onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="sg-nested-open-btn"
                              onClick={() => {
                                setActiveGroup(child);
                                setActiveGate(null);
                                setActiveGateSearch('');
                              }}
                            >
                              <span>Open Sub-Division</span>
                              <FaChevronRight size={10} />
                            </button>
                            {canManage && (
                              <div className="sg-nested-actions-group">
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary"
                                  onClick={(e) => handleOpenAssignClusters(child, e)}
                                  title={`Assign clusters directly to ${child.name}`}
                                >
                                  <FaMicrochip size={10} /> + Clusters
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-xs btn-secondary"
                                  onClick={(e) => handleOpenCreateSubDivision(child, e)}
                                  title={`Add sub-group inside ${child.name}`}
                                >
                                  <FaPlus size={10} /> Sub-Group
                                </button>
                                <button
                                  type="button"
                                  className="sg-icon-btn edit mini"
                                  onClick={() => handleOpenEdit(child)}
                                  title="Edit division"
                                >
                                  <FaEdit size={11} />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Included Gates Section */}
          <div className="sg-section-header">
            <div>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '1.25rem', fontWeight: 700, color: '#1e293b' }}>
                Included LC Gates ({activeGroupGates.length})
              </h3>
              <p style={{ margin: 0, fontSize: '0.88rem', color: '#64748b' }}>
                Click on any gate card below to inspect its connected master units and slave devices.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="sg-search-box" style={{ maxWidth: 300 }}>
                <FaSearch color="#94a3b8" />
                <input
                  type="text"
                  placeholder="Filter gates in this scope..."
                  value={activeGateSearch}
                  onChange={(e) => setActiveGateSearch(e.target.value)}
                />
                {activeGateSearch && (
                  <button
                    onClick={() => setActiveGateSearch('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}
                  >
                    <FaTimes />
                  </button>
                )}
              </div>
              {canManage && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={(e) => handleOpenAssignClusters(activeGroup, e)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                >
                  <FaPlus /> Assign Clusters
                </button>
              )}
            </div>
          </div>

          {activeGroupGates.length === 0 ? (
            <div className="sg-empty-state" style={{ padding: 48 }}>
              <FaMicrochip className="sg-empty-icon" />
              <h4 style={{ margin: '0 0 8px 0', color: '#1e293b' }}>
                {activeGateSearch ? 'No matching gates found' : `No Clusters Assigned Directly to ${activeGroup.name}`}
              </h4>
              <p style={{ margin: 0, maxWidth: 460 }}>
                {activeGateSearch
                  ? 'Try adjusting your search query.'
                  : `Assign LC Gate clusters to this ${activeGroup.parentId ? 'sub-division' : 'scope group'} to monitor level crossings under it.`}
              </p>
            </div>
          ) : (
            <div className="sg-scope-gates-grid">
              {activeGroupGates.map(item => {
                const g = item.gate;
                const mastersCount = g.masters?.length || 0;
                const slavesCount =
                  g.masters?.reduce((acc: number, m: any) => acc + (m.childDevices?.length || 0), 0) || 0;
                return (
                  <div
                    key={g.id}
                    className="sg-scope-gate-card"
                    onClick={() => handleGateClick(g)}
                  >
                    <div>
                      <div className="sg-gate-card-header">
                        <div className="sg-gate-badge">
                          <FaMicrochip /> {g.lcNumber}
                        </div>
                        <span className="sg-gate-chevron">
                          Inspect Devices <FaChevronRight size={11} />
                        </span>
                      </div>

                      <h4 className="sg-gate-location-title">
                        {g.locationName || g.name || 'LC Gate'}
                      </h4>

                      <div className="sg-gate-location-sub">
                        <FaTrain style={{ color: '#0B3C7A' }} /> {g.zone || 'Zone N/A'} • {g.division || 'Division N/A'}
                      </div>
                    </div>

                    <div className="sg-gate-hardware-pills">
                      <span className="sg-pill master-pill">
                        <FaCogs /> {mastersCount} {mastersCount === 1 ? 'Master Unit' : 'Master Units'}
                      </span>
                      <span className="sg-pill slave-pill">
                        <FaPlug /> {slavesCount} {slavesCount === 1 ? 'Slave Device' : 'Slave Devices'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3. DEDICATED GATE HARDWARE & DEVICES PAGE */}
      {viewMode === 'gate_detail' && activeGate && (
        <div className="sg-gate-detail-view fade-in">
          {/* Breadcrumb Bar */}
          <div className="sg-view-header">
            <div className="sg-breadcrumb-bar">
              <button className="btn btn-secondary btn-sm" onClick={handleBackToGroup}>
                <FaArrowLeft /> Back
              </button>
              <span className="sg-breadcrumb-crumb" onClick={handleBackToList}>Scope Groups</span>
              <span className="sg-breadcrumb-sep">/</span>
              <span className="sg-breadcrumb-crumb" onClick={handleBackToGroup}>
                {activeGroup?.name || 'Scope Group'}
              </span>
              <span className="sg-breadcrumb-sep">/</span>
              <span className="sg-breadcrumb-active">{activeGate.lcNumber}</span>
            </div>
          </div>

          {/* Gate Overview Hero Card */}
          <div className="sg-gate-hero-card">
            <div className="sg-gate-hero-top">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span className="sg-gate-hero-lc">{activeGate.lcNumber}</span>
                <span className="badge badge-blue" style={{ fontSize: '0.88rem', padding: '4px 12px' }}>
                  {activeGate.zone || 'Zone N/A'} • {activeGate.division || 'Division N/A'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <span className="sg-pill master-pill">
                  <FaCogs /> {activeGate.masters?.length || 0} Masters
                </span>
                <span className="sg-pill slave-pill">
                  <FaPlug />{' '}
                  {activeGate.masters?.reduce((acc: number, m: any) => acc + (m.childDevices?.length || 0), 0) || 0} Slaves
                </span>
              </div>
            </div>

            <h3 className="sg-gate-hero-loc">
              {activeGate.locationName || activeGate.name || 'LC Gate'}
            </h3>

            <div className="sg-gate-hero-meta">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FaTrain style={{ color: '#0B3C7A' }} /> Railway Section: {activeGate.division || 'N/A'}, {activeGate.zone || 'N/A'}
              </span>
              {activeGate.latitude && activeGate.longitude && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FaMapMarkerAlt style={{ color: '#ef4444' }} /> Coordinates: {activeGate.latitude}, {activeGate.longitude}
                </span>
              )}
            </div>
          </div>

          {/* Hardware & Devices Telemetry Section */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '1.3rem', fontWeight: 800, color: '#0f172a' }}>
                  Hardware Telemetry & Connected Devices
                </h3>
                <p style={{ margin: 0, fontSize: '0.88rem', color: '#64748b' }}>
                  Live configuration of Master units and Slave sensors installed at this gate.
                </p>
              </div>
              {activeGateLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0B3C7A', fontSize: '0.85rem' }}>
                  <FaSyncAlt className="spin" /> Updating telemetry...
                </div>
              )}
            </div>

            {(!activeGate.masters || activeGate.masters.length === 0) ? (
              <div className="sg-empty-state" style={{ padding: 48 }}>
                <FaMicrochip className="sg-empty-icon" />
                <h4 style={{ margin: '0 0 8px 0', color: '#1e293b' }}>No Master Units Configured</h4>
                <p style={{ margin: 0 }}>
                  This LC gate currently does not have any master telemetry units installed.
                </p>
              </div>
            ) : (
              <div className="sg-masters-stack">
                {activeGate.masters.map((master: any) => (
                  <div key={master.id} className="sg-master-unit-card">
                    {/* Master Card Header */}
                    <div className="sg-master-unit-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div className="sg-master-icon-badge">
                          <FaMicrochip />
                        </div>
                        <div>
                          <h4 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#0f172a' }}>
                            {master.serialNumber}
                          </h4>
                          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                            Master Unit Sequence #{master.masterSequence || 1}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="sg-power-badge">
                          {master.powerSource === 'SOLAR' ? (
                            <><FaSun style={{ color: '#f59e0b' }} /> Solar Power</>
                          ) : (
                            <><FaBolt style={{ color: '#3b82f6' }} /> Direct Current</>
                          )}
                        </span>
                        <span className="sg-slaves-count-pill">
                          {master.childDevices?.length || 0} {master.childDevices?.length === 1 ? 'Slave Device' : 'Slave Devices'}
                        </span>
                      </div>
                    </div>

                    {/* Slave Devices Panel */}
                    <div className="sg-slave-devices-panel">
                      <div className="sg-slave-devices-title">
                        <FaPlug style={{ color: '#0284c7' }} /> Connected Slave Devices ({master.childDevices?.length || 0})
                      </div>

                      {(!master.childDevices || master.childDevices.length === 0) ? (
                        <div className="sg-slave-empty">
                          No slave devices connected to this master unit yet.
                        </div>
                      ) : (
                        <div className="sg-slave-devices-grid">
                          {master.childDevices.map((dev: any) => (
                            <div key={dev.id} className="sg-slave-item-card">
                              <div className="sg-slave-item-top">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div className="sg-slave-icon">
                                    <FaPlug />
                                  </div>
                                  <strong className="sg-slave-serial">{dev.serialNumber}</strong>
                                </div>
                                <span className="sg-slave-seq-badge">Seq #{dev.deviceSequence || 1}</span>
                              </div>

                              <div className="sg-slave-item-bot">
                                <span className="sg-slave-type-name">
                                  {dev.type === 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor'}
                                </span>
                                <span className="sg-slave-type-pill">
                                  {dev.type === 'DEVICE_1' ? 'Type A' : 'Type B'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* CREATE / EDIT MODAL */}
      {isModalOpen && (
        <div className="sg-modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="sg-modal" onClick={e => e.stopPropagation()}>
            <div className="sg-modal-header">
              <h3>
                <FaLayerGroup style={{ color: formColor }} />
                {editingGroupId ? 'Edit Scope Group' : 'Create New Scope Group'}
              </h3>
              <button
                className="icon-btn"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem' }}
                onClick={() => setIsModalOpen(false)}
              >
                <FaTimes />
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="sg-modal-tabs">
              <button
                type="button"
                className={`sg-modal-tab-btn ${modalTab === 'details' ? 'active' : ''}`}
                onClick={() => setModalTab('details')}
              >
                <FaTag /> 1. Group Details
              </button>
              <button
                type="button"
                className={`sg-modal-tab-btn ${modalTab === 'subgroups' ? 'active' : ''}`}
                onClick={() => setModalTab('subgroups')}
              >
                <FaFolderPlus /> 2. Sub-Groups {formSubGroupsList.length > 0 && `(${formSubGroupsList.length})`}
              </button>
              <button
                type="button"
                className={`sg-modal-tab-btn ${modalTab === 'gates' ? 'active' : ''}`}
                onClick={() => setModalTab('gates')}
              >
                <FaMicrochip /> 3. Clusters / Gates (Optional) {selectedGateIds.size > 0 && `(${selectedGateIds.size})`}
              </button>
              <button
                type="button"
                className={`sg-modal-tab-btn ${modalTab === 'users' ? 'active' : ''}`}
                onClick={() => setModalTab('users')}
              >
                <FaUsers /> 4. Assign Users ({selectedUserIds.size})
              </button>
            </div>

            <form onSubmit={handleSubmitForm} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div className="sg-modal-body">
                {formError && (
                  <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, marginBottom: 16, fontSize: '0.9rem' }}>
                    {formError}
                  </div>
                )}

                {/* TAB 1: DETAILS */}
                {modalTab === 'details' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                        Scope Group Name <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Central Railway, Western Railway, Mumbai Division..."
                        value={formName}
                        onChange={e => setFormName(e.target.value)}
                        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.95rem' }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                        Parent Scope Group (Folder / Hierarchy Level)
                      </label>
                      <select
                        value={formParentId === null ? '' : formParentId}
                        onChange={e => setFormParentId(e.target.value ? parseInt(e.target.value, 10) : null)}
                        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.92rem', backgroundColor: '#fff' }}
                      >
                        <option value="">📁 None (Top-Level Scope Group / Zone, e.g. Central Railway)</option>
                        {scopeGroups
                          .filter(g => g.id !== editingGroupId)
                          .map(g => (
                            <option key={g.id} value={g.id}>
                              📂 {g.parent ? `${g.parent.name} / ` : ''}{g.name}
                            </option>
                          ))}
                      </select>
                      <small style={{ display: 'block', marginTop: 5, color: '#64748b', fontSize: '0.8rem', lineHeight: 1.35 }}>
                        Create a folder within folder (e.g. Central Railway → Ahmedabad Division). Users assigned to the parent group automatically inherit all child divisions and their clusters.
                      </small>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                        Description (Optional)
                      </label>
                      <textarea
                        rows={3}
                        placeholder="Provide details about which gates or areas are covered by this scope..."
                        value={formDesc}
                        onChange={e => setFormDesc(e.target.value)}
                        style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.92rem', resize: 'vertical' }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                        Group Color Accent
                      </label>
                      <div className="sg-color-swatches">
                        {COLOR_PRESETS.map(hex => (
                          <div
                            key={hex}
                            className={`sg-color-circle ${formColor === hex ? 'selected' : ''}`}
                            style={{ backgroundColor: hex }}
                            onClick={() => setFormColor(hex)}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Gate State Change SMS Alerts Checkbox */}
                    <div style={{
                      marginTop: 4,
                      padding: '14px 16px',
                      background: formAllowSms ? '#f0fdf4' : '#f8fafc',
                      border: formAllowSms ? '1.5px solid #86efac' : '1px solid #cbd5e1',
                      borderRadius: 10,
                      transition: 'all 0.2s ease'
                    }}>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer', margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={formAllowSms}
                          onChange={e => setFormAllowSms(e.target.checked)}
                          style={{ width: 19, height: 19, marginTop: 2, cursor: 'pointer', accentColor: '#16a34a' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 800, fontSize: '0.94rem', color: '#0f172a' }}>
                              📱 Allow Gate State SMS Alerts for this Scope Group
                            </span>
                            {formAllowSms ? (
                              <span style={{ fontSize: '0.72rem', fontWeight: 800, background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: 4, letterSpacing: '0.4px' }}>
                                SMS ACTIVE
                              </span>
                            ) : (
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, background: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: 4 }}>
                                DISABLED
                              </span>
                            )}
                          </div>
                          <p style={{ margin: '4px 0 0 0', fontSize: '0.82rem', color: '#475569', lineHeight: 1.45 }}>
                            When enabled, officials mapped to this scope group receive real-time transactional DLT SMS on their registered mobile numbers whenever a mapped gate transitions between <strong>OPEN</strong> and <strong>CLOSED</strong>.
                          </p>
                          <div style={{ marginTop: 8, fontSize: '0.76rem', color: '#0369a1', background: '#e0f2fe', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
                            DLT: <code>Mirtha Technologies: Level Crossing &#123;LC&#125; status changed to &#123;STATE&#125; at &#123;TIME&#125;. This is an automated monitoring alert.</code>
                          </div>
                        </div>
                      </label>
                    </div>
                  </div>
                )}

                {/* TAB 2: SUB-GROUPS */}
                {modalTab === 'subgroups' && (
                  <div>
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, marginBottom: 18 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontWeight: 750, color: '#0f172a' }}>
                        <FaFolderPlus color="#0B3C7A" size={17} />
                        <span style={{ fontSize: '1rem' }}>Create Sub-Groups Within This Group Simultaneously</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '0.86rem', color: '#64748b', lineHeight: 1.45 }}>
                        Define child divisions or sub-folders now (e.g. <em>Ahmedabad Division, Mumbai Division, Pune Division</em>). 
                        You can create a parent group and its sub-groups at the exact same time without needing to assign clusters immediately.
                      </p>

                      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                        <input
                          type="text"
                          placeholder="Enter sub-group name (e.g. Ahmedabad Division)..."
                          value={formSubGroupInput}
                          onChange={e => setFormSubGroupInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddSubGroup();
                            }
                          }}
                          style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.92rem' }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={handleAddSubGroup}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          <FaPlus /> Add Sub-Group
                        </button>
                      </div>
                    </div>

                    {/* Queued Sub-Groups list */}
                    <div style={{ marginBottom: 18 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <label style={{ fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', margin: 0 }}>
                          Sub-Groups Queued for Creation ({formSubGroupsList.length})
                        </label>
                        {formSubGroupsList.length > 0 && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={() => setFormSubGroupsList([])}
                            style={{ fontSize: '0.74rem' }}
                          >
                            Clear All
                          </button>
                        )}
                      </div>

                      {formSubGroupsList.length === 0 ? (
                        <div style={{ padding: '28px 16px', textAlign: 'center', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 8, color: '#94a3b8', fontSize: '0.88rem' }}>
                          <FaFolderOpen size={24} style={{ display: 'block', margin: '0 auto 8px auto', color: '#cbd5e1' }} />
                          No sub-groups added yet. Type a sub-group name above and click "Add Sub-Group" or press Enter.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {formSubGroupsList.map((sgName, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '10px 14px',
                                background: '#ffffff',
                                border: '1px solid #cbd5e1',
                                borderRadius: 8
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#ede9fe', color: '#6d28d9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>
                                  <FaFolder />
                                </span>
                                <div>
                                  <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>{sgName}</strong>
                                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                                    Will be created as child folder inside {formName.trim() || 'this parent group'}
                                  </div>
                                </div>
                              </div>
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ color: '#ef4444', background: '#fef2f2', borderColor: '#fecaca', padding: '4px 8px' }}
                                onClick={() => handleRemoveSubGroup(idx)}
                                title="Remove sub-group"
                              >
                                <FaTrash size={11} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* If editing an existing group, show existing child divisions */}
                    {editingGroupId && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #e2e8f0' }}>
                        <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 8 }}>
                          Existing Sub-Divisions ({getDirectChildren(editingGroupId).length})
                        </label>
                        {getDirectChildren(editingGroupId).length === 0 ? (
                          <div style={{ fontSize: '0.84rem', color: '#94a3b8' }}>
                            No existing sub-divisions currently under this group.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {getDirectChildren(editingGroupId).map(child => (
                              <div
                                key={child.id}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  padding: '8px 12px',
                                  background: '#f1f5f9',
                                  border: '1px solid #e2e8f0',
                                  borderRadius: 6,
                                  fontSize: '0.88rem'
                                }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#334155', fontWeight: 600 }}>
                                  <FaFolder color="#0B3C7A" /> {child.name}
                                </span>
                                <span className="sg-pill gates" style={{ fontSize: '0.72rem' }}>
                                  {child.gates?.length || child._count?.gates || 0} Gates
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* TAB 3: GATES PICKER */}
                {modalTab === 'gates' && (
                  <div>
                    <div style={{ padding: '12px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, marginBottom: 14, fontSize: '0.86rem', color: '#166534', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <FaInfoCircle size={18} style={{ flexShrink: 0, marginTop: 1, color: '#16a34a' }} />
                      <div>
                        <strong>Cluster Selection is Optional for Parent Groups:</strong> You do not have to select clusters right now. If this is a zonal or parent group (like Central Railway), clusters can be assigned to child sub-groups (like Ahmedabad Division). Users assigned to the parent group automatically inherit all clusters from all sub-groups.
                      </div>
                    </div>

                    <div className="sg-selector-toolbar">
                      <div className="sg-search-box" style={{ flex: '1 1 200px' }}>
                        <FaSearch color="#94a3b8" />
                        <input
                          type="text"
                          placeholder="Search gates by LC#, name, location..."
                          value={gateSearchQuery}
                          onChange={e => setGateSearchQuery(e.target.value)}
                        />
                      </div>

                      <select
                        value={gateFilterZone}
                        onChange={e => {
                          setGateFilterZone(e.target.value);
                          setGateFilterDivision('');
                        }}
                      >
                        <option value="">All Zones</option>
                        {zones.map(z => (
                          <option key={z} value={z}>{z}</option>
                        ))}
                      </select>

                      <select
                        value={gateFilterDivision}
                        onChange={e => setGateFilterDivision(e.target.value)}
                        disabled={!gateFilterZone}
                      >
                        <option value="">All Divisions</option>
                        {availableDivisions.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>

                      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={selectAllFilteredGates}
                        >
                          <FaCheckDouble /> Select All Filtered ({pickerFilteredGates.length})
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={deselectAllFilteredGates}
                        >
                          Deselect Filtered
                        </button>
                      </div>
                    </div>

                    <div style={{ marginBottom: 10, fontSize: '0.84rem', color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Showing {pickerFilteredGates.length} of {allGates.length} gates</span>
                      <strong>{selectedGateIds.size} gates selected</strong>
                    </div>

                    <div className="sg-items-picker-box">
                      {pickerFilteredGates.length === 0 ? (
                        <div style={{ padding: '30px 10px', textAlign: 'center', color: '#94a3b8' }}>
                          No gates match the current filter criteria.
                        </div>
                      ) : (
                        pickerFilteredGates.map(gate => {
                          const isSelected = selectedGateIds.has(gate.id);
                          return (
                            <div
                              key={gate.id}
                              className={`sg-item-row ${isSelected ? 'selected' : ''}`}
                              onClick={() => toggleGateSelection(gate.id)}
                            >
                              <input
                                type="checkbox"
                                className="sg-item-checkbox"
                                checked={isSelected}
                                onChange={() => {}} // handled by parent onClick
                              />
                              <div className="sg-item-details">
                                <div>
                                  <div className="sg-item-name">
                                    {gate.lcNumber} {gate.name ? `— ${gate.name}` : ''}
                                  </div>
                                  <div className="sg-item-sub">
                                    📍 {gate.locationName || 'Unspecified location'}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  {gate.zone && (
                                    <span className="badge" style={{ fontSize: '0.72rem', background: '#e2e8f0', color: '#334155' }}>
                                      {gate.zone}
                                    </span>
                                  )}
                                  {gate.division && (
                                    <span className="badge" style={{ fontSize: '0.72rem', background: '#f1f5f9', color: '#475569' }}>
                                      {gate.division}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {/* TAB 3: USERS PICKER */}
                {modalTab === 'users' && (
                  <div>
                    <div className="sg-selector-toolbar">
                      <div className="sg-search-box" style={{ flex: '1 1 220px' }}>
                        <FaSearch color="#94a3b8" />
                        <input
                          type="text"
                          placeholder="Search users by name, email, employee ID..."
                          value={userSearchQuery}
                          onChange={e => setUserSearchQuery(e.target.value)}
                        />
                      </div>

                      <select
                        value={userRoleFilter}
                        onChange={e => setUserRoleFilter(e.target.value)}
                      >
                        <option value="ALL">All Roles</option>
                        {userRolesList.map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>

                      <div style={{ marginLeft: 'auto', fontSize: '0.85rem', fontWeight: 600, color: '#0B3C7A' }}>
                        {selectedUserIds.size} users selected
                      </div>
                    </div>

                    <div className="sg-items-picker-box">
                      {pickerFilteredUsers.length === 0 ? (
                        <div style={{ padding: '30px 10px', textAlign: 'center', color: '#94a3b8' }}>
                          No users match the search.
                        </div>
                      ) : (
                        pickerFilteredUsers.map(u => {
                          const isSelected = selectedUserIds.has(u.id);
                          return (
                            <div
                              key={u.id}
                              className={`sg-item-row ${isSelected ? 'selected' : ''}`}
                              onClick={() => toggleUserSelection(u.id)}
                            >
                              <input
                                type="checkbox"
                                className="sg-item-checkbox"
                                checked={isSelected}
                                onChange={() => {}}
                              />
                              <div className="sg-item-details">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div
                                    style={{
                                      width: 32,
                                      height: 32,
                                      borderRadius: '50%',
                                      background: 'var(--primary)',
                                      color: 'white',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontWeight: 700,
                                      fontSize: '0.8rem'
                                    }}
                                  >
                                    {u.fullName?.substring(0, 2).toUpperCase() || 'U'}
                                  </div>
                                  <div>
                                    <div className="sg-item-name">{u.fullName}</div>
                                    <div className="sg-item-sub">
                                      {u.email} • ID: {u.employeeId || 'N/A'} • {u.department || 'Dept N/A'}
                                    </div>
                                  </div>
                                </div>
                                <div>
                                  <span className="badge" style={{ backgroundColor: 'var(--secondary, #0e9aa7)', color: 'white', fontSize: '0.74rem' }}>
                                    {u.role?.name || 'User'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="sg-modal-footer">
                <div>
                  {modalTab !== 'details' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        if (modalTab === 'users') setModalTab('gates');
                        else if (modalTab === 'gates') setModalTab('subgroups');
                        else if (modalTab === 'subgroups') setModalTab('details');
                      }}
                    >
                      Back
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setIsModalOpen(false)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>

                  {modalTab === 'details' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setModalTab('subgroups')}
                    >
                      Next: Sub-Groups {formSubGroupsList.length > 0 && `(${formSubGroupsList.length})`}
                    </button>
                  )}

                  {modalTab === 'subgroups' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setModalTab('gates')}
                    >
                      Next: Gates (Optional)
                    </button>
                  )}

                  {modalTab === 'gates' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setModalTab('users')}
                    >
                      Next: Assign Users ({selectedUserIds.size})
                    </button>
                  )}

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submitting}
                  >
                    {submitting
                      ? 'Saving...'
                      : editingGroupId
                      ? 'Save Scope Group'
                      : formSubGroupsList.length > 0
                      ? `Create Group + ${formSubGroupsList.length} Sub-Group${formSubGroupsList.length > 1 ? 's' : ''}`
                      : 'Create Scope Group'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}



      {/* DELETE CONFIRMATION MODAL */}
      {deleteConfirmGroup && (
        <div className="sg-modal-overlay" onClick={() => setDeleteConfirmGroup(null)}>
          <div className="sg-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="sg-modal-header" style={{ background: '#fef2f2' }}>
              <h3 style={{ color: '#b91c1c' }}>
                <FaTrash /> Delete Scope Group?
              </h3>
              <button
                className="icon-btn"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem' }}
                onClick={() => setDeleteConfirmGroup(null)}
              >
                <FaTimes />
              </button>
            </div>

            <div className="sg-modal-body">
              <p style={{ margin: '0 0 12px 0', fontSize: '0.95rem', color: '#334155' }}>
                Are you sure you want to delete the Scope Group <strong>"{deleteConfirmGroup.name}"</strong>?
              </p>
              <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
                This will unassign all {deleteConfirmGroup.gates?.length || 0} gates from this scope group. The gates and user accounts will <strong>not</strong> be deleted.
              </p>
            </div>

            <div className="sg-modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirmGroup(null)}>
                Cancel
              </button>
              <button
                className="btn"
                style={{ background: '#dc2626', color: 'white', border: 'none' }}
                onClick={handleDeleteGroup}
              >
                Yes, Delete Scope Group
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QUICK ASSIGN CLUSTERS MODAL */}
      {clusterAssignModalGroup && (
        <div className="sg-modal-overlay" onClick={() => setClusterAssignModalGroup(null)}>
          <div className="sg-modal scale-in" onClick={e => e.stopPropagation()} style={{ maxWidth: 760, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div className="sg-modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#e0f2fe', color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>
                  <FaMicrochip />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: '#0f172a' }}>
                    Assign Clusters to: <span style={{ color: clusterAssignModalGroup.color || '#0B3C7A' }}>{clusterAssignModalGroup.name}</span>
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '0.82rem', color: '#64748b' }}>
                    {clusterAssignModalGroup.parentId ? 'Sub-Division / Sub-Group' : 'Root Scope Group'} • Select LC Gates to be monitored under this scope
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#0f172a' }}
                onClick={() => setClusterAssignModalGroup(null)}
                aria-label="Close"
              >
                <FaTimes size={14} color="#0f172a" />
              </button>
            </div>

            {/* Filter toolbar */}
            <div style={{ padding: '14px 20px', background: '#ffffff', borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div className="sg-search-box" style={{ flex: '1 1 200px' }}>
                <FaSearch color="#94a3b8" />
                <input
                  type="text"
                  placeholder="Search by LC#, location, zone..."
                  value={assignSearch}
                  onChange={e => setAssignSearch(e.target.value)}
                />
                {assignSearch && (
                  <button type="button" onClick={() => setAssignSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}>
                    <FaTimes size={12} />
                  </button>
                )}
              </div>

              <select
                value={assignFilterZone}
                onChange={e => {
                  setAssignFilterZone(e.target.value);
                  setAssignFilterDiv('');
                }}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.86rem', backgroundColor: '#fff' }}
              >
                <option value="">All Zones</option>
                {zones.map(z => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>

              <select
                value={assignFilterDiv}
                onChange={e => setAssignFilterDiv(e.target.value)}
                disabled={!assignFilterZone}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.86rem', backgroundColor: '#fff' }}
              >
                <option value="">All Divisions</option>
                {(divisionsByZone[assignFilterZone] || []).map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>

              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={selectAllAssignFilteredGates}
                >
                  <FaCheckDouble size={11} /> Select All Filtered ({assignFilteredGates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={deselectAllAssignFilteredGates}
                >
                  Clear Filtered
                </button>
              </div>
            </div>

            {/* Clusters list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', maxHeight: '420px' }}>
              {assignFilteredGates.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b' }}>
                  <FaMicrochip size={28} style={{ color: '#cbd5e1', marginBottom: 8 }} />
                  <div>No clusters match your search or filters.</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
                  {assignFilteredGates.map(gate => {
                    const isSelected = assignGateIds.has(gate.id);
                    const mastersCount = gate.masters?.length || 0;
                    return (
                      <div
                        key={gate.id}
                        onClick={() => toggleAssignGate(gate.id)}
                        style={{
                          padding: '12px 14px',
                          borderRadius: 8,
                          border: isSelected ? '2px solid #0B3C7A' : '1px solid #e2e8f0',
                          backgroundColor: isSelected ? '#f0f9ff' : '#ffffff',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 12,
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // handled by container
                          style={{ width: 18, height: 18, marginTop: 2, cursor: 'pointer', accentColor: '#0B3C7A' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                            <strong style={{ fontSize: '0.96rem', color: '#0f172a' }}>{gate.lcNumber}</strong>
                            <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#e2e8f0', color: '#475569' }}>
                              {gate.zone || 'Zone N/A'}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.84rem', color: '#334155', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {gate.locationName || gate.name || 'Level Crossing'}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 4, display: 'flex', gap: 10 }}>
                            <span>Div: {gate.division || 'N/A'}</span>
                            <span>•</span>
                            <span>{mastersCount} Master{mastersCount === 1 ? '' : 's'}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: '0.9rem', color: '#334155', fontWeight: 600 }}>
                Selected: <span style={{ color: '#0B3C7A', fontWeight: 800 }}>{assignGateIds.size}</span> cluster{assignGateIds.size === 1 ? '' : 's'}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setClusterAssignModalGroup(null)}
                  disabled={assignSaving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveClusterAssignments}
                  disabled={assignSaving}
                  style={{ minWidth: 140 }}
                >
                  {assignSaving ? 'Saving Clusters...' : 'Save Clusters'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* QUICK CREATE SUB-DIVISION MODAL */}
      {subDivisionModalParent && (
        <div className="sg-modal-overlay" onClick={() => setSubDivisionModalParent(null)}>
          <div className="sg-modal scale-in" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="sg-modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ede9fe', color: '#6d28d9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>
                  <FaFolderPlus />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: '#0f172a' }}>
                    Add Sub-Division / Sub-Group
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '0.82rem', color: '#64748b' }}>
                    Create child folder inside <strong>{subDivisionModalParent.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#0f172a' }}
                onClick={() => setSubDivisionModalParent(null)}
                aria-label="Close"
              >
                <FaTimes size={14} color="#0f172a" />
              </button>
            </div>

            <form onSubmit={handleSaveSubDivision}>
              <div className="sg-modal-body" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                    Sub-Division / Sub-Group Name <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ahmedabad Division, Vadodara Division, Pune Section..."
                    value={subDivName}
                    onChange={e => setSubDivName(e.target.value)}
                    style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.95rem' }}
                    autoFocus
                  />
                  <small style={{ color: '#64748b', fontSize: '0.78rem', marginTop: 4, display: 'block' }}>
                    Users assigned to {subDivisionModalParent.name} will automatically inherit access to this sub-division and its clusters.
                  </small>
                </div>

                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                    Description (Optional)
                  </label>
                  <textarea
                    rows={2}
                    placeholder="e.g. Covers Ahmedabad to Gandhidham section level crossings..."
                    value={subDivDesc}
                    onChange={e => setSubDivDesc(e.target.value)}
                    style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.92rem', resize: 'vertical' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '0.88rem', color: '#1e293b', marginBottom: 6 }}>
                    Color Accent
                  </label>
                  <div className="sg-color-swatches">
                    {COLOR_PRESETS.map(hex => (
                      <div
                        key={hex}
                        className={`sg-color-circle ${subDivColor === hex ? 'selected' : ''}`}
                        style={{ backgroundColor: hex }}
                        onClick={() => setSubDivColor(hex)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="sg-modal-footer" style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setSubDivisionModalParent(null)}
                  disabled={subDivSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={subDivSaving || !subDivName.trim()}
                >
                  {subDivSaving ? 'Creating...' : 'Create Sub-Division'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
