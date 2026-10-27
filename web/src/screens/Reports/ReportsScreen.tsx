import { useState, useEffect, useMemo, useRef } from 'react';
import {
  FaFileExcel,
  FaFilePdf,
  FaCalendarAlt,
  FaSearch,
  FaSyncAlt,
  FaArchway,
  FaLayerGroup,
  FaTimes,
  FaFilter,
  FaColumns,
  FaChevronDown,
  FaChevronUp
} from 'react-icons/fa';
import type { User } from '../../types';
import { API_URL } from '../../config';
import { useToast } from '../../context/ToastContext';
import './ReportsScreen.css';

type Props = {
  user: User;
};

interface ClusterGate {
  id: number;
  lcNumber: string;
  name?: string | null;
  locationName: string;
  zone?: string | null;
  division?: string | null;
}

interface ClusterItem {
  id: number;
  name: string;
  color: string;
  parentId?: number | null;
  parentName?: string | null;
  gateCount: number;
  gates: ClusterGate[];
}

interface OperationalRecord {
  id: number;
  gateId: number;
  lcNumber: string;
  gateName: string;
  locationName: string;
  zone?: string | null;
  division?: string | null;
  scopeGroupName: string;
  scopeGroupColor: string;
  openedAt: string;
  closedAt: string | null;
  durationSeconds: number | null;
  durationFormatted: string;
  status: 'OPEN' | 'CLOSED' | 'EXTENDED_DELAY';
}

const authHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
});

// Clean column definitions
const REPORT_COLUMNS = [
  { key: 'scopeGroup', label: 'Cluster' },
  { key: 'lcNumber', label: 'LC Number' },
  { key: 'locationName', label: 'Location' },
  { key: 'zone', label: 'Zone' },
  { key: 'division', label: 'Division' },
  { key: 'openedDate', label: 'Date' },
  { key: 'openedTime', label: 'Opened (IST)' },
  { key: 'closedTime', label: 'Closed (IST)' },
  { key: 'durationFormatted', label: 'Duration' },
  { key: 'status', label: 'Status' },
];

export default function ReportsScreen({ user }: Props) {
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const isDeveloper = user.role === 'Developer';

  // 1. Clusters & Gates State
  const [clusters, setClusters] = useState<ClusterItem[]>([]);
  const [loadingClusters, setLoadingClusters] = useState<boolean>(true);
  const [selectedClusterIds, setSelectedClusterIds] = useState<number[]>([]);
  const [selectedGateIds, setSelectedGateIds] = useState<number[]>([]);
  const [showGateDropdown, setShowGateDropdown] = useState<boolean>(false);
  const [gateSearchText, setGateSearchText] = useState<string>('');

  // 2. Date Range State (Default: Last 7 Days)
  const [datePreset, setDatePreset] = useState<'7days' | 'today' | 'yesterday' | '30days' | 'month' | 'custom'>('7days');
  const [startDateStr, setStartDateStr] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [endDateStr, setEndDateStr] = useState<string>(() => {
    return new Date().toISOString().split('T')[0];
  });

  // 3. Filter & Sort State
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterShift, setFilterShift] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [sortBy, setSortBy] = useState<string>('openedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 4. Columns Selection State
  const [selectedExportColumns, setSelectedExportColumns] = useState<string[]>(
    REPORT_COLUMNS.map(c => c.key)
  );
  const [showColumnsPopover, setShowColumnsPopover] = useState<boolean>(false);

  // 5. Operational Records State
  const [records, setRecords] = useState<OperationalRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState<boolean>(false);

  // Pagination & Export
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const gateDropdownRef = useRef<HTMLDivElement>(null);
  const columnPopoverRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (gateDropdownRef.current && !gateDropdownRef.current.contains(e.target as Node)) {
        setShowGateDropdown(false);
      }
      if (columnPopoverRef.current && !columnPopoverRef.current.contains(e.target as Node)) {
        setShowColumnsPopover(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Debounce search query (300ms)
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Quick Date Preset Calculator
  const applyDatePreset = (preset: '7days' | 'today' | 'yesterday' | '30days' | 'month') => {
    setDatePreset(preset);
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (preset === 'today') {
      setStartDateStr(todayStr);
      setEndDateStr(todayStr);
    } else if (preset === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yStr = y.toISOString().split('T')[0];
      setStartDateStr(yStr);
      setEndDateStr(yStr);
    } else if (preset === '7days') {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      setStartDateStr(d.toISOString().split('T')[0]);
      setEndDateStr(todayStr);
    } else if (preset === '30days') {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      setStartDateStr(d.toISOString().split('T')[0]);
      setEndDateStr(todayStr);
    } else if (preset === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      setStartDateStr(startOfMonth.toISOString().split('T')[0]);
      setEndDateStr(todayStr);
    }
  };

  // 1. Fetch Clusters on Initial Mount
  const fetchClusters = async () => {
    setLoadingClusters(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/reports/clusters`, { headers: authHeaders() });
      if (!res.ok) {
        if (res.status === 403) {
          toastError('No clusters are assigned to your user account.');
        }
        return;
      }
      const data = await res.json();
      const clusterList: ClusterItem[] = data.clusters || [];
      setClusters(clusterList);

      // Select all accessible clusters and gates by default
      const allClusterIds = clusterList.map(c => c.id);
      const allGateIds = Array.from(new Set(clusterList.flatMap(c => c.gates.map(g => g.id))));
      setSelectedClusterIds(allClusterIds);
      setSelectedGateIds(allGateIds);
    } catch (err) {
      console.error('Error fetching accessible clusters:', err);
      toastError('Failed to load assigned clusters');
    } finally {
      setLoadingClusters(false);
    }
  };

  useEffect(() => {
    fetchClusters();
  }, []);

  // 2. Core Fetch Records Data
  const fetchRecordsData = async (
    targetClusterIds = selectedClusterIds,
    targetGateIds = selectedGateIds,
    start = startDateStr,
    end = endDateStr,
    search = debouncedSearch
  ) => {
    if ((targetClusterIds.length === 0 && !isDeveloper) || targetGateIds.length === 0) {
      setRecords([]);
      return;
    }

    setLoadingRecords(true);
    try {
      const url = new URL(`${API_URL}/api/v1/reports/records`);
      if (targetClusterIds.length > 0) {
        url.searchParams.append('scopeGroupIds', targetClusterIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('scopeGroupIds', 'all');
      }

      if (targetGateIds.length > 0) {
        url.searchParams.append('gateIds', targetGateIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('gateIds', 'all');
      }

      url.searchParams.append('startDate', start);
      url.searchParams.append('endDate', end);
      if (filterStatus !== 'ALL') url.searchParams.append('status', filterStatus);
      if (filterShift !== 'ALL') url.searchParams.append('shift', filterShift);
      if (search.trim()) url.searchParams.append('search', search.trim());
      url.searchParams.append('sortBy', sortBy);
      url.searchParams.append('sortOrder', sortOrder);

      const res = await fetch(url.toString(), { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRecords(data.records || []);
        setCurrentPage(1);
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to load records');
      }
    } catch (err) {
      console.error('Error fetching records:', err);
      toastError('Network error loading reports');
    } finally {
      setLoadingRecords(false);
    }
  };

  // ── REAL-TIME REACTIVE SYNC ──────────────────────────────────────────────
  // Automatically queries and updates the View Log table whenever any filter changes!
  useEffect(() => {
    if (clusters.length > 0) {
      fetchRecordsData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr, debouncedSearch);
    }
  }, [
    selectedClusterIds,
    selectedGateIds,
    startDateStr,
    endDateStr,
    filterStatus,
    filterShift,
    sortBy,
    sortOrder,
    debouncedSearch
  ]);

  // Available gates pool based on selected clusters
  const availableGates = useMemo(() => {
    const list: (ClusterGate & { clusterName: string; clusterColor: string })[] = [];
    const seenGateIds = new Set<number>();
    clusters.forEach(c => {
      if (selectedClusterIds.length === 0 || selectedClusterIds.includes(c.id)) {
        c.gates.forEach(g => {
          if (!seenGateIds.has(g.id)) {
            seenGateIds.add(g.id);
            list.push({ ...g, clusterName: c.name, clusterColor: c.color });
          }
        });
      }
    });
    return list;
  }, [clusters, selectedClusterIds]);

  // Filtered gates in gate picker
  const filteredAvailableGates = useMemo(() => {
    if (!gateSearchText.trim()) return availableGates;
    const q = gateSearchText.toLowerCase();
    return availableGates.filter(g =>
      g.lcNumber.toLowerCase().includes(q) ||
      g.locationName.toLowerCase().includes(q) ||
      (g.name && g.name.toLowerCase().includes(q))
    );
  }, [availableGates, gateSearchText]);

  // Scope Group Selection
  const handleScopeGroupChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'ALL') {
      const allCIds = clusters.map(c => c.id);
      const allGIds = Array.from(new Set(clusters.flatMap(c => c.gates.map(g => g.id))));
      setSelectedClusterIds(allCIds);
      setSelectedGateIds(allGIds);
    } else {
      const cId = parseInt(val, 10);
      setSelectedClusterIds([cId]);
      const cluster = clusters.find(c => c.id === cId);
      const clusterGateIds = Array.from(new Set((cluster?.gates || []).map(g => g.id)));
      setSelectedGateIds(clusterGateIds);
    }
  };

  // Gate Selection Toggles
  const handleToggleGate = (gateId: number) => {
    if (selectedGateIds.includes(gateId)) {
      setSelectedGateIds(prev => prev.filter(id => id !== gateId));
    } else {
      setSelectedGateIds(prev => [...prev, gateId]);
    }
  };

  const handleSelectAllGates = () => {
    const allAvailGIds = availableGates.map(g => g.id);
    setSelectedGateIds(allAvailGIds);
  };

  const handleClearGates = () => {
    setSelectedGateIds([]);
  };

  // Column Selection Toggles
  const handleToggleColumn = (colKey: string) => {
    if (selectedExportColumns.includes(colKey)) {
      if (selectedExportColumns.length <= 1) {
        toastInfo('At least one column must be selected');
        return;
      }
      setSelectedExportColumns(prev => prev.filter(k => k !== colKey));
    } else {
      setSelectedExportColumns(prev => [...prev, colKey]);
    }
  };

  const handleSelectAllColumns = () => {
    setSelectedExportColumns(REPORT_COLUMNS.map(c => c.key));
  };

  const handleResetDefaultColumns = () => {
    setSelectedExportColumns(['scopeGroup', 'lcNumber', 'locationName', 'openedDate', 'openedTime', 'closedTime', 'durationFormatted', 'status']);
  };

  // Direct Download Trigger (Excel or PDF)
  const handleDownloadReport = async (format: 'xlsx' | 'pdf') => {
    if (selectedGateIds.length === 0) {
      toastInfo('Please select at least one gate to generate the report');
      return;
    }

    setIsExporting(true);
    try {
      const url = new URL(`${API_URL}/api/v1/reports/export`);
      if (selectedClusterIds.length > 0) {
        url.searchParams.append('scopeGroupIds', selectedClusterIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('scopeGroupIds', 'all');
      }

      if (selectedGateIds.length > 0) {
        url.searchParams.append('gateIds', selectedGateIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('gateIds', 'all');
      }

      url.searchParams.append('startDate', startDateStr);
      url.searchParams.append('endDate', endDateStr);
      url.searchParams.append('format', format);
      if (filterStatus !== 'ALL') url.searchParams.append('status', filterStatus);
      if (filterShift !== 'ALL') url.searchParams.append('shift', filterShift);
      if (debouncedSearch.trim()) url.searchParams.append('search', debouncedSearch.trim());
      url.searchParams.append('sortBy', sortBy);
      url.searchParams.append('sortOrder', sortOrder);
      url.searchParams.append('columns', selectedExportColumns.join(','));

      const res = await fetch(url.toString(), { headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Export failed with status ${res.status}`);
      }

      const blob = await res.blob();
      const downloadFilename = `LC_Report_${startDateStr}_to_${endDateStr}.${format}`;

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      toastSuccess(`Report downloaded successfully as .${format}!`, 'Export Completed');
    } catch (err: any) {
      console.error('Download error:', err);
      toastError(err.message || 'Failed to download report', 'Export Error');
    } finally {
      setIsExporting(false);
    }
  };

  // Pagination Slice
  const totalPages = Math.ceil(records.length / rowsPerPage) || 1;
  const paginatedRecords = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return records.slice(start, start + rowsPerPage);
  }, [records, currentPage, rowsPerPage]);

  return (
    <div className="reports-container">
      {/* ── Top Header Bar ─────────────────────────────────────────── */}
      <div className="reports-header-card">
        <div className="reports-header-title-row">
          <div className="reports-title-group">
            <div className="reports-icon-badge">
              <FaArchway />
            </div>
            <div>
              <h2 className="reports-main-heading">Level Crossing Report Builder</h2>
              <p className="reports-sub-heading">
                Live reactive reporting: select parameters in the sidebar to instantly update and export audit logsheets.
              </p>
            </div>
          </div>

          <div className="reports-header-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => fetchRecordsData()}
              disabled={loadingRecords}
              title="Manually refresh data"
            >
              <FaSyncAlt className={loadingRecords ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── TWO-COLUMN WORKSPACE: LEFT COMPACT BUILDER + RIGHT VIEW LOG ── */}
      <div className="report-columns-layout">
        
        {/* ═══════════════════════════════════════════════════════════
            LEFT COLUMN: COMPACT REPORT BUILDER PANEL (Zero Scroll)
           ═══════════════════════════════════════════════════════════ */}
        <aside className="builder-sidebar-card">
          <div className="sidebar-header">
            <div className="sidebar-title-badge">
              <FaFilter className="text-primary" />
              <span>Report Parameters</span>
            </div>
            <span className="live-pill active">
              <span className="live-dot" /> Auto-Sync
            </span>
          </div>

          <div className="sidebar-compact-body">
            
            {/* 1. Scope Group Dropdown */}
            <div className="compact-field">
              <label>
                <FaLayerGroup className="field-icon-label text-primary" /> Scope Group / Cluster
              </label>
              <select
                value={selectedClusterIds.length === 1 ? selectedClusterIds[0] : 'ALL'}
                onChange={handleScopeGroupChange}
                disabled={loadingClusters}
              >
                <option value="ALL">All Accessible Groups ({clusters.length})</option>
                {clusters.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.gates.length} gates)
                  </option>
                ))}
              </select>
            </div>

            {/* 2. Gate Multi-Select Dropdown Popover */}
            <div className="compact-field relative-anchor" ref={gateDropdownRef}>
              <label>
                <FaArchway className="field-icon-label text-primary" /> Target LC Gates
              </label>
              <button
                type="button"
                className="dropdown-trigger-btn"
                onClick={() => setShowGateDropdown(prev => !prev)}
              >
                <span className="truncate">
                  {selectedGateIds.length === 0
                    ? '0 Gates Selected'
                    : selectedGateIds.length === availableGates.length
                    ? `All ${availableGates.length} Gates Active`
                    : `${selectedGateIds.length} of ${availableGates.length} Gates`}
                </span>
                {showGateDropdown ? <FaChevronUp size={11} /> : <FaChevronDown size={11} />}
              </button>

              {showGateDropdown && (
                <div className="gate-popover-menu">
                  <div className="popover-search">
                    <FaSearch size={11} className="text-muted" />
                    <input
                      type="text"
                      placeholder="Search gate..."
                      value={gateSearchText}
                      onChange={(e) => setGateSearchText(e.target.value)}
                    />
                    {gateSearchText && (
                      <button type="button" onClick={() => setGateSearchText('')}>
                        <FaTimes size={10} />
                      </button>
                    )}
                  </div>

                  <div className="popover-quick-bar">
                    <button type="button" onClick={handleSelectAllGates}>Select All</button>
                    <span className="sep">•</span>
                    <button type="button" onClick={handleClearGates}>Clear</button>
                  </div>

                  <div className="popover-items-list">
                    {filteredAvailableGates.length === 0 ? (
                      <div className="text-muted small p-2">No matching gates</div>
                    ) : (
                      filteredAvailableGates.map(g => {
                        const isChecked = selectedGateIds.includes(g.id);
                        return (
                          <label key={g.id} className="gate-checkbox-item">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => handleToggleGate(g.id)}
                            />
                            <strong className="text-primary">{g.lcNumber}</strong>
                            <span className="text-muted truncate ml-1">{g.locationName}</span>
                            {selectedClusterIds.length > 1 && (
                              <span
                                className="gate-item-cluster-badge"
                                style={{
                                  backgroundColor: (g.clusterColor || '#0B3C7A') + '15',
                                  color: g.clusterColor || '#0B3C7A',
                                  borderColor: (g.clusterColor || '#0B3C7A') + '33'
                                }}
                              >
                                {g.clusterName}
                              </span>
                            )}
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 3. Date Window Presets & Inputs */}
            <div className="compact-field">
              <label>
                <FaCalendarAlt className="field-icon-label text-primary" /> Date Range Window
              </label>
              <div className="compact-presets-bar">
                <button
                  type="button"
                  className={`preset-pill-sm ${datePreset === '7days' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('7days')}
                >
                  7 Days
                </button>
                <button
                  type="button"
                  className={`preset-pill-sm ${datePreset === 'today' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('today')}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={`preset-pill-sm ${datePreset === 'yesterday' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('yesterday')}
                >
                  Yesterday
                </button>
                <button
                  type="button"
                  className={`preset-pill-sm ${datePreset === 'month' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('month')}
                >
                  This Month
                </button>
              </div>

              <div className="dates-row-compact mt-1">
                <input
                  type="date"
                  value={startDateStr}
                  onChange={(e) => {
                    setStartDateStr(e.target.value);
                    setDatePreset('custom');
                  }}
                  title="Start Date"
                />
                <span className="date-arrow">➔</span>
                <input
                  type="date"
                  value={endDateStr}
                  onChange={(e) => {
                    setEndDateStr(e.target.value);
                    setDatePreset('custom');
                  }}
                  title="End Date"
                />
              </div>
            </div>

            {/* 4. Barrier Status & Operational Shift */}
            <div className="compact-row-split">
              <div className="compact-field">
                <label>Barrier Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="CLOSED">Closed Only</option>
                  <option value="EXTENDED_DELAY">Delays (&gt;15m)</option>
                  <option value="OPEN">Open Now</option>
                </select>
              </div>

              <div className="compact-field">
                <label>Operational Shift</label>
                <select
                  value={filterShift}
                  onChange={(e) => setFilterShift(e.target.value)}
                >
                  <option value="ALL">All 24 Hours</option>
                  <option value="MORNING">Morning (06-14)</option>
                  <option value="EVENING">Evening (14-22)</option>
                  <option value="NIGHT">Night (22-06)</option>
                </select>
              </div>
            </div>

            {/* 5. Keyword Search (Full Width, Zero Overlap) */}
            <div className="compact-field">
              <label>Filter by Keyword</label>
              <div className="search-wrap-compact">
                <FaSearch className="search-icon-left" />
                <input
                  type="text"
                  placeholder="Filter by LC number or location..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button type="button" className="clear-search-btn" onClick={() => setSearchQuery('')} title="Clear search">
                    <FaTimes size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* 6. Unified Sort Selector (Full Width, Descriptive) */}
            <div className="compact-field">
              <label>Sort Records By</label>
              <select
                value={`${sortBy}_${sortOrder}`}
                onChange={(e) => {
                  const [field, order] = e.target.value.split('_');
                  setSortBy(field);
                  setSortOrder(order as 'asc' | 'desc');
                }}
              >
                <option value="openedAt_desc">Date & Time: Newest to Oldest</option>
                <option value="openedAt_asc">Date & Time: Oldest to Newest</option>
                <option value="durationSeconds_desc">Duration: Longest to Shortest</option>
                <option value="durationSeconds_asc">Duration: Shortest to Longest</option>
                <option value="lcNumber_asc">LC Number: A to Z</option>
                <option value="lcNumber_desc">LC Number: Z to A</option>
                <option value="status_asc">Barrier Status (A to Z)</option>
              </select>
            </div>

            {/* 6. Columns Customizer Popover Trigger */}
            <div className="compact-field relative-anchor" ref={columnPopoverRef}>
              <div className="column-label-head">
                <label className="mb-0">
                  <FaColumns className="field-icon-label text-primary" /> Active Columns ({selectedExportColumns.length})
                </label>
                <button
                  type="button"
                  className="popover-toggle-link"
                  onClick={() => setShowColumnsPopover(prev => !prev)}
                >
                  {showColumnsPopover ? 'Close' : 'Customize ▾'}
                </button>
              </div>

              {showColumnsPopover && (
                <div className="columns-popover-menu">
                  <div className="popover-quick-bar">
                    <button type="button" onClick={handleSelectAllColumns}>Select All</button>
                    <span className="sep">•</span>
                    <button type="button" onClick={handleResetDefaultColumns}>Reset Default</button>
                  </div>
                  <div className="columns-grid-popover">
                    {REPORT_COLUMNS.map(col => {
                      const isChecked = selectedExportColumns.includes(col.key);
                      return (
                        <label key={col.key} className="col-check-item">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleColumn(col.key)}
                          />
                          <span>{col.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

          </div>

          {/* SIDEBAR FOOTER: DIRECT 1-CLICK EXPORTS */}
          <div className="sidebar-action-footer">
            <div className="export-label-row">
              <span className="export-tag-title">Direct Report Generation</span>
            </div>
            <div className="export-buttons-pair">
              <button
                type="button"
                className="btn btn-success btn-sm export-action-btn"
                onClick={() => handleDownloadReport('xlsx')}
                disabled={isExporting || selectedExportColumns.length === 0}
                title="Download Excel spreadsheet"
              >
                <FaFileExcel />
                <span>{isExporting ? 'Exporting...' : 'Excel (.xlsx)'}</span>
              </button>

              <button
                type="button"
                className="btn btn-danger btn-sm export-action-btn"
                onClick={() => handleDownloadReport('pdf')}
                disabled={isExporting || selectedExportColumns.length === 0}
                title="Download printable PDF report"
              >
                <FaFilePdf />
                <span>{isExporting ? 'Exporting...' : 'PDF (.pdf)'}</span>
              </button>
            </div>
          </div>
        </aside>

        {/* ═══════════════════════════════════════════════════════════
            RIGHT COLUMN: VIEW LOG MAIN WORKSPACE (Real-Time Reactive)
           ═══════════════════════════════════════════════════════════ */}
        <main className="view-log-main-card">
          <div className="view-log-header">
            <div>
              <div className="log-title-row">
                <FaArchway className="text-primary mr-2" />
                <h3 className="log-title">View Log: Operational Records</h3>
                {loadingRecords ? (
                  <span className="live-status-pill updating">
                    <FaSyncAlt className="spin mr-1" /> Updating...
                  </span>
                ) : (
                  <span className="live-status-pill synced">
                    <span className="pulse-dot" /> Live Synced
                  </span>
                )}
              </div>
              <span className="log-subtitle">
                Displaying <strong>{records.length}</strong> events for selected criteria ({startDateStr} to {endDateStr})
              </span>
            </div>

            <div className="view-log-header-right">
              <div className="rows-selector">
                <span className="text-muted small mr-1">Show:</span>
                <select
                  value={rowsPerPage}
                  onChange={(e) => {
                    setRowsPerPage(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                >
                  <option value={15}>15</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
          </div>

          {/* Real-time Table */}
          <div className="table-responsive">
            <table className="reports-table">
              <thead>
                <tr>
                  {selectedExportColumns.includes('scopeGroup') && <th>Cluster</th>}
                  {selectedExportColumns.includes('lcNumber') && <th>LC Number</th>}
                  {selectedExportColumns.includes('locationName') && <th>Location</th>}
                  {selectedExportColumns.includes('zone') && <th>Zone</th>}
                  {selectedExportColumns.includes('division') && <th>Division</th>}
                  {selectedExportColumns.includes('openedDate') && <th>Date</th>}
                  {selectedExportColumns.includes('openedTime') && <th>Opened (IST)</th>}
                  {selectedExportColumns.includes('closedTime') && <th>Closed (IST)</th>}
                  {selectedExportColumns.includes('durationFormatted') && <th>Duration</th>}
                  {selectedExportColumns.includes('status') && <th>Status</th>}
                </tr>
              </thead>
              <tbody>
                {loadingRecords ? (
                  <tr>
                    <td colSpan={selectedExportColumns.length || 1} className="text-center py-5">
                      <FaSyncAlt className="spin mr-2" /> Updating operational logs in real-time...
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={selectedExportColumns.length || 1} className="text-center py-5 empty-cell">
                      <FaArchway size={34} className="mb-2 text-muted" />
                      <p style={{ margin: 0, fontWeight: 700, fontSize: '0.95rem', color: '#334155' }}>
                        No operational records found for this selection.
                      </p>
                      <small className="text-muted">
                        Adjust scope groups, gates, or date range in the left builder panel.
                      </small>
                    </td>
                  </tr>
                ) : (
                  paginatedRecords.map(rec => {
                    const openedDateObj = new Date(rec.openedAt);
                    const openedDateStr = openedDateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
                    const openedTimeStr = openedDateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
                    const closedTimeStr = rec.closedAt
                      ? new Date(rec.closedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
                      : 'STILL OPEN';

                    return (
                      <tr key={rec.id}>
                        {selectedExportColumns.includes('scopeGroup') && (
                          <td>
                            <span
                              className="cluster-tag"
                              style={{ borderColor: rec.scopeGroupColor, color: rec.scopeGroupColor }}
                            >
                              {rec.scopeGroupName}
                            </span>
                          </td>
                        )}
                        {selectedExportColumns.includes('lcNumber') && (
                          <td>
                            <strong className="lc-tag">{rec.lcNumber}</strong>
                          </td>
                        )}
                        {selectedExportColumns.includes('locationName') && <td>{rec.locationName}</td>}
                        {selectedExportColumns.includes('zone') && <td>{rec.zone || '-'}</td>}
                        {selectedExportColumns.includes('division') && <td>{rec.division || '-'}</td>}
                        {selectedExportColumns.includes('openedDate') && <td>{openedDateStr}</td>}
                        {selectedExportColumns.includes('openedTime') && <td className="text-mono">{openedTimeStr}</td>}
                        {selectedExportColumns.includes('closedTime') && <td className="text-mono">{closedTimeStr}</td>}
                        {selectedExportColumns.includes('durationFormatted') && (
                          <td>
                            <span className="duration-pill">{rec.durationFormatted}</span>
                          </td>
                        )}
                        {selectedExportColumns.includes('status') && (
                          <td>
                            <span className={`status-badge ${rec.status.toLowerCase()}`}>
                              {rec.status}
                            </span>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Bar */}
          {records.length > rowsPerPage && (
            <div className="table-pagination-row">
              <span className="pagination-info">
                Showing {(currentPage - 1) * rowsPerPage + 1} to {Math.min(currentPage * rowsPerPage, records.length)} of {records.length} records
              </span>
              <div className="pagination-buttons">
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                >
                  Previous
                </button>
                <span className="page-indicator">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
