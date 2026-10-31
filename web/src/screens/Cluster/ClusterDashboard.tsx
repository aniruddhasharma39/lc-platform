import React, { useState, useEffect, useMemo } from 'react';
import { 
  FaArchway, FaMapMarkerAlt, FaCogs, FaCamera, FaEye, FaSun, 
  FaBolt, FaPlug, FaCheckCircle, FaSearchPlus, FaTimes, FaRedo, FaTrash,
  FaFilter, FaChevronDown, FaChevronUp, FaLayerGroup, FaShieldAlt, FaMicrochip,
  FaSearch, FaPlus
} from 'react-icons/fa';
import type { User } from '../../types';
import './ClusterDashboard.css';
import { API_URL } from '../../config';
import { RAILWAY_ZONES, RAILWAY_DATA } from './railwayData';
import { useToast } from '../../context/ToastContext';
import DeviceInfoModal from '../../components/DeviceInfoModal';

type Props = {
  user: User;
};

const authHeaders = () => ({ 'Authorization': `Bearer ${localStorage.getItem('token')}` });

const getFullImageUrl = (url?: string) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_URL}${url}`;
};

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest First' },
  { value: 'name_asc', label: 'Gate Name (A–Z)' },
  { value: 'name_desc', label: 'Gate Name (Z–A)' },
  { value: 'lc_asc', label: 'LC Number (Ascending)' },
  { value: 'zone_asc', label: 'Zone (A–Z)' },
  { value: 'location_asc', label: 'Location (A–Z)' },
];

export default function ClusterDashboard(_props: Props) {
  const { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo } = useToast();
  const [gates, setGates] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'create_gate' | 'gate_detail'>('list');
  const [selectedGate, setSelectedGate] = useState<any>(null);
  const [deviceInfoModalTarget, setDeviceInfoModalTarget] = useState<any | null>(null);

  // Zone/Division reference data (API first, constant fallback)
  const [refZones, setRefZones] = useState<string[]>(RAILWAY_ZONES);
  const [refDivisions, setRefDivisions] = useState<Record<string, string[]>>(RAILWAY_DATA);

  // Filters & sort
  const [quickSearch, setQuickSearch] = useState('');
  const [filterZone, setFilterZone] = useState('');
  const [filterDivision, setFilterDivision] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [filterName, setFilterName] = useState('');
  const [filterLc, setFilterLc] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [showFilters, setShowFilters] = useState(false);

  // Modals
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // Scope Groups State
  const [developerScopeId, setDeveloperScopeId] = useState('');
  const [allScopeGroupsList, setAllScopeGroupsList] = useState<any[]>([]);
  const [myScopeGroups, setMyScopeGroups] = useState<any[]>([]);

  const fetchReferenceData = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/reference-data`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.zones) && data.zones.length > 0) setRefZones(data.zones);
        if (data.divisionsByZone && Object.keys(data.divisionsByZone).length > 0) setRefDivisions(data.divisionsByZone);
      }
    } catch (e) {
      console.warn('Failed to fetch zone/division reference data', e);
    }
  };

  const fetchScopeData = async () => {
    try {
      // 1. Always fetch my-scope to see which Scope Groups the current user belongs to
      const myRes = await fetch(`${API_URL}/api/v1/scope-groups/my-scope`, { headers: authHeaders() });
      if (myRes.ok) {
        const myData = await myRes.json();
        setMyScopeGroups(myData.scopeGroups || []);
      }

      // 2. If user is Developer, also fetch all scope groups for the admin dropdown selector
      if (_props.user.role === 'Developer') {
        const res = await fetch(`${API_URL}/api/v1/scope-groups`, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          setAllScopeGroupsList(Array.isArray(data) ? data : []);
        }
      }
    } catch (e) {
      console.warn('Failed to load scope data', e);
    }
  };

  const fetchGates = async (overrideScopeId?: string) => {
    setLoading(true);
    setFetchError(null);
    try {
      const activeScope = overrideScopeId !== undefined ? overrideScopeId : developerScopeId;
      const query = activeScope ? `?scopeGroupId=${encodeURIComponent(activeScope)}` : '';
      const res = await fetch(`${API_URL}/api/v1/lcgate${query}`, {
        headers: authHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        setGates(data);
        if (selectedGate) {
          const updated = data.find((g: any) => g.id === selectedGate.id);
          if (updated) setSelectedGate(updated);
        }
      } else if (res.status === 401) {
        setFetchError('Your session has expired. Please log in again.');
      } else {
        const err = await res.json().catch(() => ({}));
        setFetchError(err.error || `Server responded with status ${res.status}`);
      }
    } catch (e: any) {
      console.error(e);
      setFetchError(e.message || 'Network error while loading gates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGates();
    fetchReferenceData();
    fetchScopeData();
  }, []);

  const divisionOptions = useMemo(() => {
    if (filterZone) return refDivisions[filterZone] || [];
    const all = Object.values(refDivisions).flat();
    return [...new Set(all)];
  }, [filterZone, refDivisions]);

  const visibleGates = useMemo(() => {
    const q = quickSearch.trim().toLowerCase();
    const filtered = gates.filter((g) => {
      const quickMatch = !q || (
        (g.name || '').toLowerCase().includes(q) ||
        (g.lcNumber || '').toLowerCase().includes(q) ||
        (g.locationName || '').toLowerCase().includes(q) ||
        (g.zone || '').toLowerCase().includes(q) ||
        (g.division || '').toLowerCase().includes(q)
      );
      const zoneMatch = !filterZone || (g.zone || '').toLowerCase() === filterZone.toLowerCase();
      const divisionMatch = !filterDivision || (g.division || '').toLowerCase() === filterDivision.toLowerCase();
      const locMatch = !filterLocation || (g.locationName || '').toLowerCase().includes(filterLocation.toLowerCase());
      const nameMatch = !filterName || (g.name || '').toLowerCase().includes(filterName.toLowerCase());
      const lcMatch = !filterLc || (g.lcNumber || '').toLowerCase().includes(filterLc.toLowerCase());
      return quickMatch && zoneMatch && divisionMatch && locMatch && nameMatch && lcMatch;
    });
    const sorted = [...filtered];
    switch (sortBy) {
      case 'name_asc': sorted.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break;
      case 'name_desc': sorted.sort((a, b) => (b.name || '').localeCompare(a.name || '')); break;
      case 'lc_asc': sorted.sort((a, b) => (a.lcNumber || '').localeCompare(b.lcNumber || '', undefined, { numeric: true })); break;
      case 'zone_asc': sorted.sort((a, b) => (a.zone || '').localeCompare(b.zone || '')); break;
      case 'location_asc': sorted.sort((a, b) => (a.locationName || '').localeCompare(b.locationName || '')); break;
      default: sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return sorted;
  }, [gates, quickSearch, filterZone, filterDivision, filterLocation, filterName, filterLc, sortBy]);

  const resetFilters = () => {
    setQuickSearch('');
    setFilterZone('');
    setFilterDivision('');
    setFilterLocation('');
    setFilterName('');
    setFilterLc('');
    setSortBy('newest');
    toastInfo('Gate filters and sorting reset to defaults.', 'Filters Reset');
  };

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (quickSearch.trim()) count++;
    if (filterZone) count++;
    if (filterDivision) count++;
    if (filterLocation.trim()) count++;
    if (filterName.trim()) count++;
    if (filterLc.trim()) count++;
    if (sortBy !== 'newest') count++;
    return count;
  }, [quickSearch, filterZone, filterDivision, filterLocation, filterName, filterLc, sortBy]);

  const hasActiveFilters = activeFilterCount > 0;

  const handleDeleteGate = async () => {
    if (deleteConfirmText !== selectedGate.name && deleteConfirmText !== selectedGate.lcNumber) {
      toastWarning("Confirmation text does not match gate name or LC number.", "Verification Failed");
      return;
    }
    const gateLabel = selectedGate.name || selectedGate.lcNumber;
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${selectedGate.id}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        setShowDeleteModal(false);
        setDeleteConfirmText('');
        setSelectedGate(null);
        setView('list');
        fetchGates();
        toastSuccess(`Gate "${gateLabel}" deleted successfully.`, "Gate Deleted");
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to delete gate from server.', 'Delete Error');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error while deleting gate.', 'Network Error');
    }
  };

  return (
    <div className="cluster-container fade-in">
      {view === 'list' && (
        <div className="gate-list-view">
          {/* Header Row: Search on Left, Filter Toggle & Actions on Right */}
          <div className="cluster-header-row mb-4">
            <div className="cluster-search-box">
              <FaSearch className="cluster-search-icon" size={14} />
              <input
                type="text"
                placeholder="Search gates by LC Number, Name, Zone, Location..."
                value={quickSearch}
                onChange={(e) => setQuickSearch(e.target.value)}
              />
              {quickSearch && (
                <button type="button" className="cluster-clear-btn" onClick={() => setQuickSearch('')}>
                  <FaTimes size={12} />
                </button>
              )}
            </div>

            <div className="cluster-header-actions">
              {/* Developer Scope Selector */}
              {_props.user.role === 'Developer' && allScopeGroupsList.length > 0 && (
                <div className="cluster-scope-selector-box">
                  <FaLayerGroup size={13} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                  <span className="cluster-scope-label">Scope View:</span>
                  <select
                    value={developerScopeId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDeveloperScopeId(val);
                      fetchGates(val);
                      toastInfo(val === 'all' ? 'Switched to All Gates (Admin View).' : val ? 'Filtered gates by selected scope group.' : 'Switched to Assigned Scope.', 'Scope View');
                    }}
                    className="cluster-scope-select"
                  >
                    <option value="">My Assigned Scope</option>
                    <option value="all">All Gates (Admin View)</option>
                    {allScopeGroupsList.map(sg => (
                      <option key={sg.id} value={sg.id}>{sg.name} ({sg._count?.gates || sg.gates?.length || 0} gates)</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Filter Toggle Button */}
              <button
                type="button"
                className={`btn-toggle-filters ${showFilters ? 'active' : ''} ${hasActiveFilters ? 'has-active' : ''}`}
                onClick={() => setShowFilters(prev => !prev)}
                title={showFilters ? 'Close filter options' : 'Open filter options'}
              >
                <FaFilter className="filter-btn-icon" />
                <span>Filters</span>
                {activeFilterCount > 0 && (
                  <span className="active-filter-badge">{activeFilterCount}</span>
                )}
                {showFilters ? <FaChevronUp size={11} /> : <FaChevronDown size={11} />}
              </button>

              <button className="btn-primary flex items-center gap-2 pulse-hover cluster-create-btn" onClick={() => setView('create_gate')}>
                <FaPlus size={13} />
                <span>Create New Gate</span>
              </button>
            </div>
          </div>

          {/* Active Filter Chips Strip (Visible when filter panel is collapsed but filters are applied) */}
          {!showFilters && hasActiveFilters && (
            <div className="active-filters-chips-strip mb-4 fade-in">
              <span className="active-chips-label">Active Filters:</span>
              {filterZone && (
                <span className="filter-chip">
                  Zone: {filterZone}
                  <button type="button" onClick={() => { setFilterZone(''); setFilterDivision(''); }}>✕</button>
                </span>
              )}
              {filterDivision && (
                <span className="filter-chip">
                  Div: {filterDivision}
                  <button type="button" onClick={() => setFilterDivision('')}>✕</button>
                </span>
              )}
              {filterLocation && (
                <span className="filter-chip">
                  Location: {filterLocation}
                  <button type="button" onClick={() => setFilterLocation('')}>✕</button>
                </span>
              )}
              {filterName && (
                <span className="filter-chip">
                  Gate: {filterName}
                  <button type="button" onClick={() => setFilterName('')}>✕</button>
                </span>
              )}
              {filterLc && (
                <span className="filter-chip">
                  LC: {filterLc}
                  <button type="button" onClick={() => setFilterLc('')}>✕</button>
                </span>
              )}
              {sortBy !== 'newest' && (
                <span className="filter-chip">
                  Sort: {SORT_OPTIONS.find(o => o.value === sortBy)?.label}
                  <button type="button" onClick={() => setSortBy('newest')}>✕</button>
                </span>
              )}
              <button type="button" className="btn-clear-all-chips" onClick={resetFilters}>
                Clear All
              </button>
            </div>
          )}

          {/* Collapsible Filter Bar: Only rendered when user clicks 'Filters' */}
          {showFilters && (
            <div className="cluster-toolbar glass-card mb-6 fade-in">
              <div className="filter-grid">
                <div className="form-group">
                  <label>Zone</label>
                  <select className="glass-input" value={filterZone} onChange={(e) => { setFilterZone(e.target.value); setFilterDivision(''); }}>
                    <option value="">All Zones</option>
                    {refZones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Division</label>
                  <select className="glass-input" value={filterDivision} onChange={(e) => setFilterDivision(e.target.value)}>
                    <option value="">All Divisions</option>
                    {divisionOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Location</label>
                  <input className="glass-input" type="text" placeholder="Search location…" value={filterLocation} onChange={(e) => setFilterLocation(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Gate Name</label>
                  <input className="glass-input" type="text" placeholder="Search gate name…" value={filterName} onChange={(e) => setFilterName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>LC Number</label>
                  <input className="glass-input" type="text" placeholder="e.g. LC-0001" value={filterLc} onChange={(e) => setFilterLc(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Sort By</label>
                  <select className="glass-input" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                    {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="toolbar-bottom-actions">
                <div className="filter-active-summary">
                  {hasActiveFilters ? (
                    <span className="filter-status-text">
                      <FaCheckCircle style={{ color: '#10b981' }} /> {activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} applied
                    </span>
                  ) : (
                    <span className="filter-status-text" style={{ color: 'var(--text-muted)' }}>Showing all records without filters</span>
                  )}
                </div>

                <div className="filter-action-buttons">
                  {hasActiveFilters && (
                    <button type="button" className="btn-small btn-outline" onClick={resetFilters}>
                      ✕ Clear Filters
                    </button>
                  )}
                  <button type="button" className="btn-small btn-apply-filter" onClick={() => setShowFilters(false)}>
                    Close Filter Panel
                  </button>
                </div>
              </div>
            </div>
          )}

          {fetchError && (
            <div className="alert-card alert-danger mb-4 fade-in" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '12px 16px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span>⚠️ {fetchError}</span>
              <button className="btn-small btn-primary" onClick={() => fetchGates()} style={{ padding: '6px 14px' }}>Retry</button>
            </div>
          )}

          {/* Active Scope Banner for assigned scopes */}
          {myScopeGroups.length > 0 && developerScopeId !== 'all' && (
            <div style={{ margin: '0 0 16px 0', padding: '10px 16px', background: 'rgba(11, 60, 122, 0.05)', border: '1px solid rgba(11, 60, 122, 0.15)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FaLayerGroup style={{ color: 'var(--primary)' }} />
                <span style={{ fontSize: '0.88rem', color: '#1e293b' }}>
                  <strong>Assigned Scope:</strong> {myScopeGroups.map(s => s.name).join(', ')}
                </span>
              </div>
              <span className="badge" style={{ backgroundColor: 'var(--primary)', color: 'white', fontSize: '0.75rem' }}>
                {visibleGates.length} {visibleGates.length === 1 ? 'Gate Accessible' : 'Gates Accessible'}
              </span>
            </div>
          )}

          {loading ? (
            <div className="spinner-container"><div className="spinner"></div></div>
          ) : gates.length === 0 ? (
            <div className="empty-state glass-card">
              <div className="empty-icon" style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                {myScopeGroups.length === 0 && _props.user.role === 'Developer' ? (
                  <FaArchway size={48} color="#64748b" />
                ) : (
                  <FaShieldAlt size={48} color="#0B3C7A" />
                )}
              </div>
              <h3>{myScopeGroups.length === 0 && _props.user.role === 'Developer' ? 'No Gates Found' : 'No Gates in Your Assigned Scope'}</h3>
              <p>
                {myScopeGroups.length === 0 && _props.user.role === 'Developer'
                  ? 'Get started by creating your first Level Crossing Gate.'
                  : 'You have not been assigned to any Scope Groups containing LC Gates yet. Please contact your system administrator or developer.'}
              </p>
            </div>
          ) : visibleGates.length === 0 ? (
            <div className="empty-state glass-card">
              <div className="empty-icon">🔍</div>
              <h3>No Matching Gates</h3>
              <p>No gates match the current filters. Try clearing or relaxing them.</p>
              <button className="btn-small btn-outline mt-3" onClick={resetFilters}>Clear Filters</button>
            </div>
          ) : (
            <div className="grid">
              {visibleGates.map(gate => (
                <div key={gate.id} className="gate-card glass-card hover-lift" onClick={() => { setSelectedGate(gate); setView('gate_detail'); }} style={{ padding: '24px', cursor: 'pointer' }}>
                  <div className="gate-header flex justify-between items-start" style={{ marginBottom: '28px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
                      <h3 className="m-0" style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-main)', lineHeight: '1.2' }}>{gate.name || (gate.locationName ? `${gate.locationName} (${gate.lcNumber})` : gate.lcNumber)}</h3>
                      <span className="badge badge-blue" style={{ fontSize: '0.85rem', padding: '6px 12px', letterSpacing: '0.5px' }}>{gate.lcNumber || 'No LC#'}</span>
                      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                        {gate.zone && <span className="badge badge-indigo" style={{ fontSize: '0.75rem', padding: '4px 10px' }}>{gate.zone}</span>}
                        {gate.division && <span className="badge" style={{ fontSize: '0.75rem', padding: '4px 10px', backgroundColor: 'rgba(14, 154, 167, 0.1)', color: '#0e9aa7', fontWeight: 600 }}>{gate.division}</span>}
                      </div>
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
                    <div className="flex justify-between items-center pt-3 border-t" style={{ borderColor: 'var(--border)', marginTop: '8px' }}>
                      <span className="text-xs text-muted">ID: <strong>{gate.lcNumber || 'N/A'}</strong></span>
                      <button 
                        className="btn-small btn-outline flex items-center gap-1.5 hover-lift"
                        style={{ fontSize: '0.8rem', padding: '4px 10px', cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeviceInfoModalTarget({ gate });
                        }}
                      >
                        <FaMicrochip /> Device Info
                      </button>
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
          zones={refZones}
          divisionsByZone={refDivisions}
          onCancel={() => setView('list')} 
          onSuccess={() => { setView('list'); fetchGates(); }} 
        />
      )}

      {view === 'gate_detail' && selectedGate && (
        <GateDetailView 
          gate={selectedGate} 
          onBack={() => { setView('list'); setSelectedGate(null); }} 
          onUpdate={fetchGates}
          onOpenDeviceInfo={setDeviceInfoModalTarget}
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

      {/* Ubiquitous Device Info & Manifest Modal */}
      {deviceInfoModalTarget && (
        <DeviceInfoModal
          isOpen={Boolean(deviceInfoModalTarget)}
          onClose={() => setDeviceInfoModalTarget(null)}
          gate={deviceInfoModalTarget.gate}
          master={deviceInfoModalTarget.master}
        />
      )}
    </div>
  );
}

function CreateGateForm({ onCancel, onSuccess, zones, divisionsByZone }: any) {
  const { success: toastSuccess, error: toastError, warning: toastWarning } = useToast();
  const [name, setName] = useState('');
  const [lcNumberDigits, setLcNumberDigits] = useState('');
  const [locationName, setLocationName] = useState('');
  const [zone, setZone] = useState('');
  const [division, setDivision] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [gettingLocation, setGettingLocation] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Device Registry Integration
  const [deviceList, setDeviceList] = useState<any[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');


  useEffect(() => {
    fetch(`${API_URL}/api/v1/devices?limit=100`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    })
      .then(res => res.json())
      .then(data => {
        if (data.devices) {
          setDeviceList(data.devices);
        }
      })
      .catch(console.error);
  }, []);

  const handleDeviceSelect = (devId: string) => {
    setSelectedDeviceId(devId);
    if (!devId) return;
    const dev = deviceList.find(d => d.id.toString() === devId);
    if (dev) {
      if (!name) {
        setName(dev.thingName);
      }
    }
  };

  const chosenDev = deviceList.find(d => d.id.toString() === selectedDeviceId);
  const currentDivisions = zone ? (divisionsByZone[zone] || []) : [];
  const canSubmit = Boolean(locationName.trim() && zone && division && (chosenDev || lcNumberDigits.trim()));

  const handleGetLocation = (e: React.MouseEvent) => {
    e.preventDefault();
    setGettingLocation(true);
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLat(position.coords.latitude.toString());
          setLng(position.coords.longitude.toString());
          setGettingLocation(false);
          toastSuccess(`Acquired GPS: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`, 'GPS Located');
        },
        (error) => {
          toastError(`Error getting location: ${error.message}`, 'Location Error');
          setGettingLocation(false);
        },
        { enableHighAccuracy: true }
      );
    } else {
      toastWarning("Geolocation is not supported by your browser.", "GPS Unavailable");
      setGettingLocation(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const gateLcNumber = chosenDev ? chosenDev.thingName : `LC-${lcNumberDigits.trim()}`;
      const res = await fetch(`${API_URL}/api/v1/lcgate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          name: name || undefined,
          lcNumber: gateLcNumber,
          deviceId: chosenDev ? chosenDev.id : undefined,
          locationName,
          zone,
          division,
          latitude: lat ? parseFloat(lat) : undefined,
          longitude: lng ? parseFloat(lng) : undefined
        })
      });
      if (res.ok) {
        toastSuccess(`LC Gate "${gateLcNumber}" created successfully.`, 'Gate Created');
        onSuccess();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to create gate', 'Creation Failed');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error occurred while creating gate.', 'Network Error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="title-gradient m-0">Create New LC Gate</h3>
        <button className="btn-icon" onClick={onCancel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FaTimes size={16} /></button>
      </div>
      
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        {/* Select from Device Registry */}
        <div className="form-group" style={{ background: 'rgba(11, 60, 122, 0.05)', padding: '14px', borderRadius: 10, border: '1.5px solid rgba(11, 60, 122, 0.2)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--primary)', fontWeight: 700, fontSize: '0.95rem' }}>
            <FaMicrochip /> Select Provisioned Device from Registry
          </label>
          <select 
            className="glass-input" 
            value={selectedDeviceId}
            onChange={(e) => handleDeviceSelect(e.target.value)}
            style={{ marginTop: 6 }}
          >
            <option value="">— Select from Device Registry (or enter manual number below) —</option>
            {deviceList.map(dev => (
              <option key={dev.id} value={dev.id.toString()}>
                {dev.thingName} ({dev.deviceType}) {dev.gate ? `[Assigned to ${dev.gate.lcNumber}]` : '★ [Unassigned]'}
              </option>
            ))}
          </select>
          <small className="text-muted mt-1 block" style={{ fontSize: '0.8rem', lineHeight: 1.4 }}>
            {chosenDev 
              ? `Using "${chosenDev.thingName}" as the Gate ID & cluster identifier. Numbering will be identical.` 
              : 'Provision devices beforehand in AWS IoT Core and pick one here to automatically adopt its ID and map it.'}
          </small>
        </div>

        {chosenDev ? (
          <div className="form-group">
            <label style={{ fontWeight: 600 }}>Gate / Cluster Identifier (from selected device)</label>
            <div style={{ 
              padding: '0.65rem 0.9rem', 
              background: 'rgba(11, 60, 122, 0.08)', 
              borderRadius: 8, 
              fontWeight: 700, 
              color: 'var(--primary)',
              fontSize: '1.05rem',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid rgba(11, 60, 122, 0.2)'
            }}>
              <FaMicrochip /> {chosenDev.thingName}
            </div>
          </div>
        ) : (
          <div className="form-group">
            <label>LC Number (Manual entry if no device selected) *</label>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg" style={{ color: 'var(--primary-color)' }}>LC -</span>
              <input 
                className="glass-input flex-1" 
                type="text" 
                required={!chosenDev}
                placeholder="0001" 
                value={lcNumberDigits} 
                onChange={e => setLcNumberDigits(e.target.value.replace(/\D/g, ''))} 
              />
            </div>
          </div>
        )}

        <div className="form-group">
          <label>Railway Zone *</label>
          <select className="glass-input" required value={zone} onChange={(e) => { setZone(e.target.value); setDivision(''); }}>
            <option value="">Select Zone…</option>
            {(zones || []).map((z: string) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Division *</label>
          <select className="glass-input" required disabled={!zone} value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="">{zone ? 'Select Division…' : 'Select Zone first…'}</option>
            {currentDivisions.map((d: string) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Gate Name (Optional)</label>
          <input className="glass-input" type="text" placeholder="e.g. North Gate" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Location Description *</label>
          <input className="glass-input" type="text" required placeholder="e.g. Near Station X" value={locationName} onChange={e => setLocationName(e.target.value)} />
        </div>
        
        <div className="location-box glass-panel p-4 rounded-lg">
          <div className="flex justify-between items-center mb-2">
            <label className="m-0">GPS Coordinates</label>
            <button className="btn-small btn-primary flex items-center gap-1" onClick={handleGetLocation} disabled={gettingLocation}>
              {gettingLocation ? 'Locating...' : <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><FaMapMarkerAlt /> Auto-fill GPS</span>}
            </button>
          </div>
          <div className="flex gap-4">
            <input className="glass-input flex-1" type="number" step="any" placeholder="Latitude" value={lat} onChange={e => setLat(e.target.value)} />
            <input className="glass-input flex-1" type="number" step="any" placeholder="Longitude" value={lng} onChange={e => setLng(e.target.value)} />
          </div>
        </div>

        <button type="submit" className="btn-primary w-full mt-4 py-3 text-lg" disabled={submitting || !canSubmit}>
          {submitting ? 'Creating...' : 'Create Gate'}
        </button>
      </form>
    </div>
  );
}

function GateDetailView({ gate, onBack, onUpdate, onOpenDeviceInfo }: any) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [addingMaster, setAddingMaster] = useState(false);
  const [addingDeviceToMaster, setAddingDeviceToMaster] = useState<number | null>(null);
  const [uploadingEvidenceFor, setUploadingEvidenceFor] = useState<any>(null);
  const [viewingEvidenceFor, setViewingEvidenceFor] = useState<any>(null);
  const [lightboxPhoto, setLightboxPhoto] = useState<any>(null);

  const [masterToDelete, setMasterToDelete] = useState<any>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const executeDeleteMaster = async (masterId: number) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/masters/${masterId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        setMasterToDelete(null);
        setDeleteConfirmText('');
        toastSuccess('Master unit deleted successfully.', 'Hardware Updated');
        onUpdate();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to delete master unit', 'Delete Failed');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error while deleting master unit.', 'Network Error');
    }
  };

  const executeDeleteDevice = async (deviceId: number) => {
    if (!window.confirm("Are you sure you want to delete this Slave Device?")) return;
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/devices/${deviceId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        toastSuccess('Slave device removed successfully.', 'Hardware Updated');
        onUpdate();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to delete slave device', 'Delete Failed');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error while deleting slave device.', 'Network Error');
    }
  };

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
              {gate.lcNumber}
            </h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {gate.locationName && (
                <div style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 500 }}>{gate.locationName}</div>
              )}
              {gate.zone && <div className="badge badge-blue" style={{ fontSize: '0.85rem', padding: '6px 12px', fontWeight: 600 }}>{gate.zone}</div>}
              {gate.division && <div className="badge" style={{ fontSize: '0.85rem', padding: '6px 12px', fontWeight: 600, backgroundColor: 'rgba(14, 154, 167, 0.1)', color: '#0e9aa7' }}>{gate.division}</div>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            className="btn-small btn-primary flex items-center gap-2 hover-lift"
            style={{ padding: '9px 16px', fontSize: '0.88rem', cursor: 'pointer' }}
            onClick={() => onOpenDeviceInfo?.({ gate })}
          >
            <FaMicrochip /> Device Info &amp; Manifest
          </button>
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
                <div className="empty-icon text-4xl mb-3" style={{ display: 'flex', justifyContent: 'center' }}>
                  <FaCogs size={48} color="#64748b" />
                </div>
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
                        className="btn-small btn-primary flex items-center gap-2 hover-lift" 
                        style={{ padding: '8px 12px', fontSize: '0.85rem', cursor: 'pointer' }}
                        onClick={() => onOpenDeviceInfo?.({ gate, master })}
                      >
                        <FaMicrochip style={{ fontSize: '0.95rem' }} /> Device Info
                      </button>
                      <button 
                        className="btn-small flex items-center gap-2 hover-lift" 
                        style={{ padding: '8px 12px', fontSize: '0.85rem', cursor: 'pointer', backgroundColor: '#0B3C7A', color: '#ffffff', border: 'none', borderRadius: '6px' }}
                        onClick={() => setViewingEvidenceFor(master)}
                      >
                        <FaEye style={{ fontSize: '0.95rem' }} /> View Evidence
                      </button>
                      <button 
                        className="btn-small btn-outline flex items-center gap-2 hover-lift" 
                        style={{ padding: '8px 12px', fontSize: '0.85rem', cursor: 'pointer' }}
                        onClick={() => setUploadingEvidenceFor(master)}
                      >
                        <FaCamera style={{ fontSize: '0.95rem' }} /> Upload Evidence
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
                    <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {master.powerSource === 'SOLAR' ? (
                        <><FaSun style={{ color: '#f59e0b' }} /> Solar Power</>
                      ) : (
                        <><FaBolt style={{ color: '#3b82f6' }} /> Direct Current</>
                      )}
                    </span>
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
                                <div style={{ backgroundColor: 'rgba(11, 60, 122, 0.08)', padding: '8px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <FaPlug style={{ color: '#0284c7', fontSize: '1.1rem' }} />
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

      {/* ── VIEW ALL EVIDENCE MODAL (MASTER, SIM, POWER & SLAVES) ── */}
      {viewingEvidenceFor && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.75)', backdropFilter: 'blur(4px)' }}
          onClick={() => setViewingEvidenceFor(null)}
        >
          <div 
            className="glass-panel w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6 rounded-2xl relative"
            style={{ backgroundColor: '#ffffff', color: '#0f172a' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-4 mb-4 border-b border-gray-200">
              <div>
                <h3 className="text-xl font-bold flex items-center gap-2 m-0" style={{ color: '#0B3C7A' }}>
                  <FaEye /> Cluster Evidence: Master #{viewingEvidenceFor.masterSequence} ({viewingEvidenceFor.serialNumber})
                </h3>
                <p className="text-sm text-gray-500 m-0 mt-1">
                  Complete photographic verification proofs for all gateway units, SIM cards, power sources & connected slaves.
                </p>
              </div>
              <button 
                className="btn-secondary py-1 px-3"
                onClick={() => setViewingEvidenceFor(null)}
              >
                <FaTimes /> Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 1. Master ESP Evidence */}
              {(() => {
                const ev = (viewingEvidenceFor.evidences || []).find((e: any) => e.category === 'MASTER');
                return (
                  <EvidenceCardViewer
                    title="Master Unit (ESP Gateway)"
                    subtitle={`Serial: ${viewingEvidenceFor.serialNumber}`}
                    evidence={ev}
                    onPreview={() => ev?.imageUrl && setLightboxPhoto({ url: getFullImageUrl(ev.imageUrl), title: 'Master Unit (ESP Gateway)', ev })}
                  />
                );
              })()}

              {/* 2. Installed SIM Card Evidence */}
              {(() => {
                const ev = (viewingEvidenceFor.evidences || []).find((e: any) => e.category === 'SIM_CARD');
                return (
                  <EvidenceCardViewer
                    title="Installed SIM Card"
                    subtitle="Cellular SIM & ICCID Proof"
                    evidence={ev}
                    onPreview={() => ev?.imageUrl && setLightboxPhoto({ url: getFullImageUrl(ev.imageUrl), title: 'Installed SIM Card', ev })}
                  />
                );
              })()}

              {/* 3. Power Source Evidence */}
              {(() => {
                const ev = (viewingEvidenceFor.evidences || []).find((e: any) => e.category === 'POWER_SOURCE');
                return (
                  <EvidenceCardViewer
                    title={viewingEvidenceFor.powerSource === 'SOLAR' ? 'Solar Power System' : 'Direct Grid Power Supply'}
                    subtitle={viewingEvidenceFor.powerSource === 'SOLAR' ? 'Solar Panels & Battery System' : 'Grid AC Power Supply'}
                    evidence={ev}
                    onPreview={() => ev?.imageUrl && setLightboxPhoto({ url: getFullImageUrl(ev.imageUrl), title: 'Power Source Proof', ev })}
                  />
                );
              })()}

              {/* 4. Connected Slaves Evidence */}
              {(viewingEvidenceFor.childDevices || []).map((child: any) => {
                const ev = (viewingEvidenceFor.evidences || []).find((e: any) => e.childDeviceId === child.id || (e.category === child.type && e.childDeviceId === child.id))
                  || (child.evidences && child.evidences[0]);
                const isTypeA = child.type === 'DEVICE_1';
                return (
                  <EvidenceCardViewer
                    key={child.id}
                    title={`Slave #${child.deviceSequence}: ${child.serialNumber}`}
                    subtitle={isTypeA ? 'Limit Switch & Hall Effect Sensors' : 'Tilt & Angle Sensor'}
                    evidence={ev}
                    onPreview={() => ev?.imageUrl && setLightboxPhoto({ url: getFullImageUrl(ev.imageUrl), title: `Slave: ${child.serialNumber}`, ev })}
                  />
                );
              })}
            </div>

            <div className="mt-6 pt-4 border-t border-gray-200 flex justify-end gap-3">
              <button 
                className="btn-outline flex items-center gap-2 py-2 px-4 text-sm"
                onClick={() => {
                  const m = viewingEvidenceFor;
                  setViewingEvidenceFor(null);
                  setUploadingEvidenceFor(m);
                }}
              >
                <FaCamera /> Open Upload / Re-upload Checklist
              </button>
              <button 
                className="btn-primary py-2 px-4 text-sm"
                style={{ backgroundColor: '#0B3C7A' }}
                onClick={() => setViewingEvidenceFor(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── LIGHTBOX ZOOM POPUP ── */}
      {lightboxPhoto && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}
          onClick={() => setLightboxPhoto(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
            <button 
              className="absolute -top-10 right-0 text-white text-xl p-2 bg-black bg-opacity-50 rounded-full hover:bg-opacity-80"
              onClick={() => setLightboxPhoto(null)}
            >
              <FaTimes />
            </button>
            <img 
              src={lightboxPhoto.url} 
              alt={lightboxPhoto.title} 
              className="max-h-[75vh] max-w-full rounded-lg object-contain shadow-2xl" 
            />
            <div className="mt-3 text-center text-white">
              <h4 className="text-base font-bold m-0">{lightboxPhoto.title}</h4>
              {lightboxPhoto.ev?.latitude && lightboxPhoto.ev?.longitude && (
                <p className="text-xs text-gray-300 m-0 mt-1">
                  GPS: {lightboxPhoto.ev.latitude.toFixed(6)}° N, {lightboxPhoto.ev.longitude.toFixed(6)}° E
                </p>
              )}
              {lightboxPhoto.ev?.createdAt && (
                <p className="text-xs text-gray-400 m-0">
                  Timestamp: {new Date(lightboxPhoto.ev.createdAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Standalone Helper Component for Evidence Cards in Viewer Modal ──
function EvidenceCardViewer({ title, subtitle, evidence, onPreview }: { title: string; subtitle: string; evidence: any; onPreview: () => void }) {
  const hasPhoto = !!evidence?.imageUrl;
  return (
    <div 
      className="p-3 rounded-xl border flex items-start gap-3 transition-all"
      style={{
        backgroundColor: hasPhoto ? '#f0fdf4' : '#f8fafc',
        borderColor: hasPhoto ? '#86efac' : '#e2e8f0',
      }}
    >
      {hasPhoto ? (
        <img 
          src={getFullImageUrl(evidence.imageUrl)} 
          alt={title}
          className="w-20 h-20 rounded-lg object-cover cursor-pointer hover:opacity-90 flex-shrink-0 shadow-sm border border-green-300"
          onClick={onPreview}
          title="Click to view full photo"
        />
      ) : (
        <div className="w-20 h-20 rounded-lg bg-gray-100 border border-gray-300 flex items-center justify-center text-gray-400 flex-shrink-0">
          <FaCamera size={24} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <h5 className="font-bold text-sm text-gray-900 m-0 truncate">{title}</h5>
          <span 
            className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase"
            style={{
              backgroundColor: hasPhoto ? '#dcfce7' : '#f1f5f9',
              color: hasPhoto ? '#15803d' : '#64748b',
            }}
          >
            {hasPhoto ? 'VERIFIED' : 'PENDING'}
          </span>
        </div>
        <p className="text-xs text-gray-500 m-0 mt-0.5">{subtitle}</p>
        {hasPhoto ? (
          <div className="mt-2">
            {evidence.latitude && evidence.longitude && (
              <span className="text-[11px] text-blue-700 font-mono block">
                GPS: {Number(evidence.latitude).toFixed(4)}, {Number(evidence.longitude).toFixed(4)}
              </span>
            )}
            <button 
              type="button"
              className="text-xs font-bold text-blue-600 hover:underline mt-1 flex items-center gap-1"
              onClick={onPreview}
            >
              <FaEye size={11} /> View Full Photo
            </button>
          </div>
        ) : (
          <span className="text-[11px] text-gray-400 italic block mt-2">No photo recorded yet</span>
        )}
      </div>
    </div>
  );
}

function CreateMasterForm({ gate, onCancel, onSuccess }: any) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [masterSequence, setMasterSequence] = useState('1');
  const [powerSource, setPowerSource] = useState('SOLAR');
  const [submitting, setSubmitting] = useState(false);

  // Device Registry Integration
  const [deviceList, setDeviceList] = useState<any[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  // SIM Photo Attachment
  const [simPhotoBase64, setSimPhotoBase64] = useState<string | null>(null);
  const [simPhotoPreview, setSimPhotoPreview] = useState<string | null>(null);

  const handleSimFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      setSimPhotoBase64(result);
      setSimPhotoPreview(result);
    };
    reader.readAsDataURL(file);
  };

  const clearSimPhoto = () => {
    setSimPhotoBase64(null);
    setSimPhotoPreview(null);
  };

  useEffect(() => {
    fetch(`${API_URL}/api/v1/lcgate/${gate.id}/next-master-sequence`, {
      headers: authHeaders()
    })
      .then(r => r.json())
      .then(data => {
        if (data.nextSequence) setMasterSequence(data.nextSequence.toString());
      })
      .catch(console.error);

    fetch(`${API_URL}/api/v1/devices?limit=100&deviceType=MASTER&unassigned=true`, {
      headers: authHeaders()
    })
      .then(r => r.json())
      .then(data => {
        if (data.devices) {
          setDeviceList(data.devices);
          // Auto-select if a master device matches this gate's LC number
          const matching = data.devices.find((d: any) => 
            d.thingName.startsWith(gate.lcNumber) && (!d.gateId || d.gateId === gate.id) && !d.masterId
          );
          if (matching) {
            setSelectedDeviceId(matching.id.toString());
          }
        }
      })
      .catch(console.error);
  }, [gate.id, gate.lcNumber]);

  const chosenDevice = deviceList.find(d => d.id.toString() === selectedDeviceId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDeviceId) {
      toastError('Please select a provisioned Master device from AWS IoT Registry.', 'Device Required');
      return;
    }
    const chosen = deviceList.find(d => d.id.toString() === selectedDeviceId);
    if (!chosen) {
      toastError('Selected AWS IoT device is invalid.', 'Device Error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${gate.id}/masters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders()
        },
        body: JSON.stringify({ 
          masterSequence: parseInt(masterSequence, 10), 
          powerSource,
          deviceId: chosen.id,
        })
      });
      if (res.ok) {
        const createdMaster = await res.json().catch(() => ({}));
        const masterIdToUse = createdMaster?.id;

        // If SIM photo was selected, upload evidence immediately
        if (simPhotoBase64 && masterIdToUse) {
          try {
            let lat = gate.latitude || 0;
            let lng = gate.longitude || 0;
            if ('geolocation' in navigator) {
              const pos: any = await new Promise((resolve) => {
                navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { timeout: 3500 });
              });
              if (pos?.coords) {
                lat = pos.coords.latitude;
                lng = pos.coords.longitude;
              }
            }
            await fetch(`${API_URL}/api/v1/evidence`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...authHeaders()
              },
              body: JSON.stringify({
                masterId: masterIdToUse,
                category: 'SIM_CARD',
                imageBase64: simPhotoBase64,
                latitude: lat,
                longitude: lng
              })
            });
          } catch (evErr) {
            console.warn('Failed to upload SIM photo on creation:', evErr);
          }
        }

        toastSuccess(`Master Unit ${chosenDevice ? chosenDevice.thingName : `${gate.lcNumber}-${masterSequence.padStart(2, '0')}`} added successfully${simPhotoBase64 ? ' with SIM photo' : ''}.`, 'Master Unit Added');
        onSuccess();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to add master unit', 'Hardware Error');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error while creating master unit.', 'Network Error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="m-0 title-gradient">Add Master Unit</h3>
        <button className="btn-icon" onClick={onCancel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FaTimes size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        {/* Device Registry Dropdown (Mandatory) */}
        <div className="form-group" style={{ background: 'rgba(11, 60, 122, 0.04)', padding: 12, borderRadius: 8, border: '1px solid rgba(11, 60, 122, 0.12)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--primary)', fontWeight: 600 }}>
            <FaMicrochip /> Select Provisioned Master from Registry *
          </label>
          <select 
            className="glass-input" 
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            required
          >
            <option value="">{deviceList.length === 0 ? '-- No unassigned Master devices found in registry --' : '-- Select AWS IoT Thing Name * --'}</option>
            {deviceList.map(dev => (
              <option key={dev.id} value={dev.id.toString()}>
                {dev.thingName} {dev.firmwareVersion ? `(${dev.firmwareVersion})` : ''}
              </option>
            ))}
          </select>
          {deviceList.length === 0 ? (
            <small style={{ color: '#dc2626', marginTop: 6, display: 'block', fontWeight: 500 }}>
              ⚠️ No unassigned Master devices in registry. Please provision a Master device in AWS IoT Core first.
            </small>
          ) : (
            <small className="text-muted mt-1 block">
              Mandatory: Select a Master hardware device registered via Fleet Provisioning / AWS IoT Core.
            </small>
          )}
        </div>

        <div className="form-group">
          <label>Master Serial Identifier *</label>
          <div className="flex items-center gap-2">
            <input 
              className="glass-input flex-1 font-bold" 
              style={{ backgroundColor: 'rgba(0,0,0,0.05)', cursor: 'not-allowed', color: chosenDevice ? 'var(--primary)' : '#94a3b8' }} 
              type="text" 
              readOnly
              value={chosenDevice ? chosenDevice.thingName : ''} 
              placeholder="Select an AWS IoT device above"
            />
          </div>
          <small className="mt-1 block" style={{ color: chosenDevice ? '#059669' : '#dc2626' }}>
            {chosenDevice ? 'Authoritative identifier strictly from AWS IoT Device Registry.' : 'Mandatory: Select a provisioned Master device above.'}
          </small>
        </div>
        <div className="form-group">
          <label>Power Source *</label>
          <select className="glass-input" value={powerSource} onChange={e => setPowerSource(e.target.value)}>
            <option value="SOLAR">Solar Power</option>
            <option value="DIRECT">Direct Current Supply</option>
          </select>
        </div>

        {/* Optional SIM Card Photo Upload */}
        <div className="form-group" style={{ background: 'rgba(16, 185, 129, 0.05)', padding: 12, borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#047857', fontWeight: 600 }}>
            <FaCamera /> Upload SIM Card Photo (Optional)
          </label>
          <input 
            type="file" 
            accept="image/*" 
            className="glass-input mt-2" 
            onChange={handleSimFileChange} 
          />
          {simPhotoPreview && (
            <div className="mt-2 flex items-center gap-3">
              <img src={simPhotoPreview} alt="SIM Preview" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '2px solid #10b981' }} />
              <button type="button" className="btn-secondary text-xs" onClick={clearSimPhoto} style={{ padding: '4px 8px' }}>Remove</button>
            </div>
          )}
          <small className="text-muted mt-1 block">
            Attach photo of the installed SIM card & ICCID number. You can also view or update it anytime in the Evidence Checklist.
          </small>
        </div>
        <button type="submit" className="btn-primary w-full mt-4 py-3" disabled={submitting || !selectedDeviceId}>
          {submitting ? 'Saving...' : 'Create Master Unit'}
        </button>
      </form>
    </div>
  );
}

function CreateDeviceForm({ master, onCancel, onSuccess }: any) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [type, setType] = useState('DEVICE_1');
  const [submitting, setSubmitting] = useState(false);

  // Compute initial sequence based on already loaded childDevices
  const [nextSequence, setNextSequence] = useState<number>(() => {
    const letter = 'A';
    const prefix = `${master.serialNumber}-${letter}`;
    const taken = new Set<number>();
    (master.childDevices || []).forEach((d: any) => {
      if (d.deviceSequence && d.deviceSequence > 0 && d.type === 'DEVICE_1') taken.add(d.deviceSequence);
      if (d.serialNumber === prefix) taken.add(1);
      else if (d.serialNumber?.startsWith(`${prefix}-`)) {
        const num = parseInt(d.serialNumber.slice(`${prefix}-`.length), 10);
        if (!isNaN(num)) taken.add(num);
      }
    });
    let seq = 1;
    while (taken.has(seq)) seq++;
    return seq;
  });

  // Query API to ensure live consistency with database
  useEffect(() => {
    let isMounted = true;
    fetch(`${API_URL}/api/v1/lcgate/masters/${master.id}/next-device-sequence?type=${type}`, {
      headers: authHeaders()
    })
      .then(r => r.json())
      .then(data => {
        if (isMounted && data.nextSequence) {
          setNextSequence(data.nextSequence);
        }
      })
      .catch(console.error);

    return () => { isMounted = false; };
  }, [master.id, type]);

  const letter = type === 'DEVICE_1' ? 'A' : 'B';
  const derivedSerial = `${master.serialNumber}-${letter}-${nextSequence}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/masters/${master.id}/devices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders()
        },
        body: JSON.stringify({ 
          type, 
          deviceSequence: nextSequence,
          serialNumber: derivedSerial,
        })
      });
      if (res.ok) {
        toastSuccess(`Wired Slave Unit ${derivedSerial} (${type === 'DEVICE_1' ? 'Barrier A' : 'Barrier B'}) added successfully.`, 'Wired Hardware Linked');
        onSuccess();
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to add slave device', 'Hardware Error');
      }
    } catch (e: any) {
      console.error(e);
      toastError(e.message || 'Network error while creating slave device.', 'Network Error');
    }
    setSubmitting(false);
  };

  return (
    <div className="glass-card max-w-lg mx-auto slide-up">
      <div className="flex justify-between items-center mb-6">
        <h3 className="m-0 title-gradient">Add Wired Slave Unit</h3>
        <button className="btn-icon" onClick={onCancel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FaTimes size={16} /></button>
      </div>
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        {/* Wired Architecture Notice */}
        <div className="form-group" style={{ background: 'rgba(11, 60, 122, 0.05)', padding: 14, borderRadius: 10, border: '1px solid rgba(11, 60, 122, 0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--primary)', fontWeight: 700, marginBottom: 6 }}>
            <FaPlug /> Hardwired Physical Sub-Assembly
          </div>
          <p className="text-sm m-0" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Slave units have no separate GSM modem or MCU; they communicate directly via hardware wiring to Master Unit <strong>{master.serialNumber}</strong>. Multiple slave units of the same type are sequentially numbered: <code>{master.serialNumber}-A-1</code>, <code>{master.serialNumber}-A-2</code> (Barrier A) or <code>{master.serialNumber}-B-1</code>, <code>{master.serialNumber}-B-2</code> (Barrier B).
          </p>
        </div>

        <div className="form-group">
          <label>Wired Barrier Type *</label>
          <select className="glass-input" value={type} onChange={e => setType(e.target.value)}>
            <option value="DEVICE_1">Device 1 (Barrier A / HallEffect Sensor + LimitSwitch)</option>
            <option value="DEVICE_2">Device 2 (Barrier B / HallEffect Sensor + LimitSwitch)</option>
          </select>
        </div>

        <div className="form-group">
          <label>Derived Slave Serial Identifier *</label>
          <div className="flex items-center gap-2">
            <input 
              className="glass-input flex-1 font-bold" 
              style={{ backgroundColor: 'rgba(0,0,0,0.05)', cursor: 'not-allowed', color: 'var(--primary)' }}
              type="text" 
              readOnly
              value={derivedSerial} 
            />
          </div>
          <small className="text-muted mt-1 block">
            Automated sequential identifier #{nextSequence} for {type === 'DEVICE_1' ? 'Type A (Barrier A)' : 'Type B (Barrier B)'} under Master Unit {master.serialNumber}.
          </small>
        </div>

        <div className="form-group" style={{ background: 'var(--surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, display: 'block', marginBottom: 6 }}>
            Hardware Sensors Attached:
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge badge-blue">HallEffect Sensor</span>
            <span className="badge badge-indigo">LimitSwitch</span>
          </div>
        </div>

        <button type="submit" className="btn-primary w-full mt-4 py-3" disabled={submitting}>
          {submitting ? 'Linking...' : `Connect Wired Unit (${derivedSerial})`}
        </button>
      </form>
    </div>
  );
}

/**
 * Self-contained evidence checklist for a single Master Unit.
 * Maintains its own evidence list so View / Re-upload / Delete update the UI
 * immediately without needing the parent's gate object to refresh.
 */
function CentralizedEvidenceUpload({ master, onClose }: any) {
  const [evidenceList, setEvidenceList] = useState<any[]>(master.evidences || []);

  const findEv = (category: string, childDeviceId?: number | null) =>
    evidenceList.find((e: any) => e.category === category && (e.childDeviceId ?? null) === (childDeviceId ?? null));

  const handleUploaded = (saved: any) => {
    setEvidenceList((prev) => {
      const others = prev.filter((e: any) => !(e.category === saved.category && (e.childDeviceId ?? null) === (saved.childDeviceId ?? null)));
      return [...others, saved];
    });
  };

  const handleDeleted = (id: number) => {
    setEvidenceList((prev) => prev.filter((e: any) => e.id !== id));
  };

  const masterEv = findEv('MASTER');
  const simEv = findEv('SIM_CARD');
  const powerEv = findEv('POWER_SOURCE');

  return (
    <div className="glass-card slide-up">
      <div className="flex justify-between items-center mb-6 border-b pb-4 border-opacity-20 border-white">
        <h3 className="m-0 title-gradient">Upload Evidence Checklist</h3>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>
      
      <p className="text-muted mb-6">Upload photographic evidence for all components of Master {master.serialNumber}. Photos will be securely geo-stamped.</p>

      <div className="evidence-list grid gap-4">
        <EvidenceItem 
          title="Master Unit (ESP)" 
          description="Photo showing the ESP installation"
          evidence={masterEv}
          masterId={master.id}
          category="MASTER"
          onUploaded={handleUploaded}
          onDeleted={handleDeleted}
        />

        <EvidenceItem 
          title="SIM Card Photo" 
          description="Photo showing the installed SIM card & ICCID number"
          evidence={simEv}
          masterId={master.id}
          category="SIM_CARD"
          onUploaded={handleUploaded}
          onDeleted={handleDeleted}
        />

        <EvidenceItem 
          title={`${master.powerSource === 'SOLAR' ? 'Solar Panel' : 'Direct Power'} Source`}
          description={`Photo verifying the ${master.powerSource} installation`}
          evidence={powerEv}
          masterId={master.id}
          category="POWER_SOURCE"
          onUploaded={handleUploaded}
          onDeleted={handleDeleted}
        />

        {master.childDevices?.map((dev: any) => (
          <EvidenceItem 
            key={dev.id}
            title={`Slave ${dev.type}`} 
            description={dev.type === 'DEVICE_1' ? 'Hall Effect + Limit Switch' : 'Tilt Sensor'}
            evidence={findEv(dev.type, dev.id)}
            masterId={master.id}
            childDeviceId={dev.id}
            category={dev.type}
            onUploaded={handleUploaded}
            onDeleted={handleDeleted}
          />
        ))}
      </div>
    </div>
  );
}

function EvidenceItem({ title, description, evidence, masterId, childDeviceId, category, onUploaded, onDeleted }: any) {
  const { success: toastSuccess, error: toastError, warning: toastWarning } = useToast();
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!('geolocation' in navigator)) {
      toastWarning('Device location is strictly required to upload evidence proof.', 'GPS Required');
      e.target.value = '';
      return;
    }

    setUploading(true);

    // Strictly verify and acquire device location before uploading
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latitude = pos.coords.latitude;
        const longitude = pos.coords.longitude;

        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64String = reader.result as string;

          try {
            const res = await fetch(`${API_URL}/api/v1/evidence`, {
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
                latitude,
                longitude
              })
            });

            if (res.ok) {
              const saved = await res.json();
              toastSuccess(`Evidence photo for "${title}" uploaded successfully.`, 'Evidence Uploaded');
              onUploaded(saved);
            } else {
              const err = await res.json().catch(() => ({}));
              toastError(err.message || err.error || 'Upload failed', 'Upload Failed');
            }
          } catch (err: any) {
            console.error(err);
            toastError('Upload failed: ' + (err.message || 'Network error'), 'Network Error');
          } finally {
            setUploading(false);
            if (e.target) e.target.value = '';
          }
        };
        reader.readAsDataURL(file);
      },
      (err) => {
        setUploading(false);
        if (e.target) e.target.value = '';

        if (err.code === 1) { // PERMISSION_DENIED
          toastError('GPS location is strictly required to verify installation proof. Please allow location access in your browser settings.', 'Location Access Denied');
        } else if (err.code === 2) { // POSITION_UNAVAILABLE
          toastWarning('Please turn ON your device location / GPS in system settings before uploading evidence.', 'Location Turned Off');
        } else if (err.code === 3) { // TIMEOUT
          toastWarning('Could not acquire GPS coordinates in time. Please check your GPS signal and try again.', 'GPS Timed Out');
        } else {
          toastError(`Location Error: ${err.message || 'Unable to get location'}`, 'Location Error');
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleDelete = async () => {
    if (!evidence) return;
    if (!window.confirm(`Delete the uploaded photo for "${title}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/evidence/${evidence.id}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        toastSuccess(`Evidence photo for "${title}" deleted successfully.`, 'Evidence Removed');
        onDeleted(evidence.id);
      } else {
        toastError('Failed to delete evidence photo from server.', 'Delete Failed');
      }
    } catch (err) {
      console.error(err);
      toastError('Network error while deleting evidence.', 'Network Error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`evidence-item flex justify-between items-center p-4 rounded-xl transition-all ${evidence ? 'bg-green-900 bg-opacity-20 border border-green-500' : 'glass-panel'}`}>
      <div>
        <h4 className="m-0 text-lg flex items-center gap-2">
          {evidence ? <FaCheckCircle style={{ color: '#10b981' }} /> : <FaCamera style={{ color: '#64748b' }} />}
          {title}
        </h4>
        <p className="text-sm text-muted m-0 mt-1">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        {uploading ? (
          <div className="flex flex-col gap-1 items-end" style={{ minWidth: '130px' }}>
            <div style={{ width: '100%', height: '6px', background: 'rgba(59, 130, 246, 0.2)', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '100%', background: '#3b82f6', animation: 'pulse 1.2s infinite' }} />
            </div>
            <span style={{ fontSize: '0.75rem', color: '#60a5fa' }}>Uploading…</span>
          </div>
        ) : evidence ? (
          <>
            <a 
              href={getFullImageUrl(evidence?.imageUrl)} 
              target="_blank" 
              rel="noreferrer" 
              className="btn-secondary py-1 px-3 text-xs flex items-center gap-1"
              style={{ textDecoration: 'none' }}
            >
              <FaSearchPlus /> View
            </a>
            <label className="btn-small btn-outline cursor-pointer flex items-center gap-1" style={{ cursor: 'pointer', fontSize: '0.75rem', padding: '4px 10px' }}>
              <FaRedo size={11} /> Re-upload
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFileChange} />
            </label>
            <button 
              className="btn-small btn-outline flex items-center gap-1"
              style={{ color: '#ef4444', borderColor: '#ef4444', fontSize: '0.75rem', padding: '4px 10px', cursor: 'pointer' }}
              onClick={handleDelete}
              disabled={deleting}
              title="Delete Photo"
            >
              {deleting ? '…' : <><FaTrash size={11} /> Delete</>}
            </button>
          </>
        ) : (
          <label className="btn-primary cursor-pointer">
            Upload
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFileChange} />
          </label>
        )}
      </div>
    </div>
  );
}