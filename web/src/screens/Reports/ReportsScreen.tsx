import { useState, useEffect, useMemo } from 'react';
import {
  FaFileExcel,
  FaFilePdf,
  FaCalendarAlt,
  FaSearch,
  FaSyncAlt,
  FaPrint,
  FaArchway,
  FaLayerGroup,
  FaSortAmountDown,
  FaSortAmountUp,
  FaTimes,
  FaCheck,
  FaEye,
  FaFilter,
  FaColumns
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
  const [sortBy, setSortBy] = useState<string>('openedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 4. Columns Selection State (controls both the View Log table and file export)
  const [selectedExportColumns, setSelectedExportColumns] = useState<string[]>(
    REPORT_COLUMNS.map(c => c.key)
  );

  // 5. Operational Records State
  const [records, setRecords] = useState<OperationalRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState<boolean>(false);

  // Pagination
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isExporting, setIsExporting] = useState<boolean>(false);

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

  // 1. Fetch Clusters and Initialize Hierarchy Selection
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
      const allGateIds = clusterList.flatMap(c => c.gates.map(g => g.id));
      setSelectedClusterIds(allClusterIds);
      setSelectedGateIds(allGateIds);

      // Fetch preview data on initial load
      fetchRecordsData(allClusterIds, allGateIds, startDateStr, endDateStr);
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

  // 2. Fetch Records Data from Backend
  const fetchRecordsData = async (
    targetClusterIds = selectedClusterIds,
    targetGateIds = selectedGateIds,
    start = startDateStr,
    end = endDateStr
  ) => {
    if (targetClusterIds.length === 0 && !isDeveloper) {
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
      if (searchQuery.trim()) url.searchParams.append('search', searchQuery.trim());
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

  // Available gates pool based on selected clusters
  const availableGates = useMemo(() => {
    const list: (ClusterGate & { clusterName: string; clusterColor: string })[] = [];
    clusters.forEach(c => {
      if (selectedClusterIds.length === 0 || selectedClusterIds.includes(c.id)) {
        c.gates.forEach(g => {
          list.push({ ...g, clusterName: c.name, clusterColor: c.color });
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

  // Cluster Selection Toggles
  const handleToggleCluster = (clusterId: number) => {
    const isSelected = selectedClusterIds.includes(clusterId);
    const cluster = clusters.find(c => c.id === clusterId);
    const clusterGateIds = (cluster?.gates || []).map(g => g.id);

    if (isSelected) {
      const nextClusterIds = selectedClusterIds.filter(id => id !== clusterId);
      setSelectedClusterIds(nextClusterIds);
      setSelectedGateIds(prev => prev.filter(id => !clusterGateIds.includes(id)));
    } else {
      setSelectedClusterIds(prev => [...prev, clusterId]);
      setSelectedGateIds(prev => Array.from(new Set([...prev, ...clusterGateIds])));
    }
  };

  const handleSelectAllClusters = () => {
    const allCIds = clusters.map(c => c.id);
    const allGIds = clusters.flatMap(c => c.gates.map(g => g.id));
    setSelectedClusterIds(allCIds);
    setSelectedGateIds(allGIds);
  };

  const handleClearAllClusters = () => {
    setSelectedClusterIds([]);
    setSelectedGateIds([]);
  };

  // Gate Selection Toggles
  const handleToggleGate = (gateId: number) => {
    if (selectedGateIds.includes(gateId)) {
      setSelectedGateIds(prev => prev.filter(id => id !== gateId));
    } else {
      setSelectedGateIds(prev => [...prev, gateId]);
    }
  };

  const handleSelectAllAvailableGates = () => {
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
      if (searchQuery.trim()) url.searchParams.append('search', searchQuery.trim());
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
                Configure parameters in the builder column to preview operational logsheets and export audit reports.
              </p>
            </div>
          </div>

          <div className="reports-header-actions">
            <button
              className="btn btn-secondary"
              onClick={() => fetchRecordsData()}
              disabled={loadingRecords}
              title="Refresh current data"
            >
              <FaSyncAlt className={loadingRecords ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── TWO-COLUMN WORKSPACE: LEFT BUILDER PANEL + RIGHT VIEW LOG ── */}
      <div className="report-columns-layout">
        
        {/* ═══════════════════════════════════════════════════════════
            LEFT COLUMN: REPORT BUILDER CONTROL PANEL
           ═══════════════════════════════════════════════════════════ */}
        <aside className="builder-sidebar-card">
          <div className="sidebar-header">
            <div className="sidebar-title-badge">
              <FaFilter className="text-primary" />
              <span>Report Parameters</span>
            </div>
            <span className="sidebar-tag">BUILDER</span>
          </div>

          <div className="sidebar-scrollable-body">
            {/* SECTION 1: Scope Groups / Clusters */}
            <div className="sidebar-section">
              <div className="section-head-row">
                <span className="section-title">
                  <FaLayerGroup className="mr-1 text-primary" /> Scope Groups
                </span>
                <div className="section-quick-links">
                  <button type="button" onClick={handleSelectAllClusters}>All</button>
                  <span className="sep">|</span>
                  <button type="button" onClick={handleClearAllClusters}>Clear</button>
                </div>
              </div>

              {loadingClusters ? (
                <div className="py-2 text-center text-muted small">
                  <FaSyncAlt className="spin mr-1" /> Loading...
                </div>
              ) : (
                <div className="sidebar-chips-wrap">
                  {clusters.map(c => {
                    const isSelected = selectedClusterIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`sidebar-pill-chip ${isSelected ? 'active' : ''}`}
                        onClick={() => handleToggleCluster(c.id)}
                      >
                        <span className="pill-dot" style={{ backgroundColor: c.color || '#0B3C7A' }} />
                        <span className="pill-text">{c.name}</span>
                        <span className="pill-badge">{c.gates.length}</span>
                        {isSelected && <FaCheck className="pill-check" size={9} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SECTION 2: LC Gates */}
            <div className="sidebar-section">
              <div className="section-head-row">
                <span className="section-title">
                  <FaArchway className="mr-1 text-primary" /> Level Crossing Gates
                </span>
                <div className="section-quick-links">
                  <button type="button" onClick={handleSelectAllAvailableGates}>All</button>
                  <span className="sep">|</span>
                  <button type="button" onClick={handleClearGates}>Clear</button>
                </div>
              </div>

              {availableGates.length > 4 && (
                <div className="sidebar-search-box">
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
              )}

              <div className="sidebar-chips-wrap gate-chips-max">
                {filteredAvailableGates.length === 0 ? (
                  <div className="text-muted small py-1">
                    {availableGates.length === 0 ? 'Select a Scope Group' : 'No match'}
                  </div>
                ) : (
                  filteredAvailableGates.map(g => {
                    const isSelected = selectedGateIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        className={`sidebar-pill-chip ${isSelected ? 'active' : ''}`}
                        onClick={() => handleToggleGate(g.id)}
                        title={`${g.lcNumber} - ${g.locationName}`}
                      >
                        <strong className="text-primary">{g.lcNumber}</strong>
                        <span className="text-muted ml-1" style={{ fontSize: '0.72rem' }}>{g.locationName}</span>
                        {isSelected && <FaCheck className="pill-check" size={9} />}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* SECTION 3: Date Range & Operational Filters */}
            <div className="sidebar-section">
              <span className="section-title mb-2 d-block">
                <FaCalendarAlt className="mr-1 text-primary" /> Date Window & Filters
              </span>

              {/* Date Presets */}
              <div className="sidebar-presets-grid">
                <button
                  type="button"
                  className={`preset-btn ${datePreset === '7days' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('7days')}
                >
                  Last 7 Days
                </button>
                <button
                  type="button"
                  className={`preset-btn ${datePreset === 'today' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('today')}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={`preset-btn ${datePreset === 'yesterday' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('yesterday')}
                >
                  Yesterday
                </button>
                <button
                  type="button"
                  className={`preset-btn ${datePreset === 'month' ? 'active' : ''}`}
                  onClick={() => applyDatePreset('month')}
                >
                  This Month
                </button>
              </div>

              {/* Date Inputs */}
              <div className="sidebar-field-row mt-2">
                <div className="sidebar-field">
                  <label>Start Date</label>
                  <input
                    type="date"
                    value={startDateStr}
                    onChange={(e) => {
                      setStartDateStr(e.target.value);
                      setDatePreset('custom');
                    }}
                  />
                </div>
                <div className="sidebar-field">
                  <label>End Date</label>
                  <input
                    type="date"
                    value={endDateStr}
                    onChange={(e) => {
                      setEndDateStr(e.target.value);
                      setDatePreset('custom');
                    }}
                  />
                </div>
              </div>

              {/* Barrier Status & Shift */}
              <div className="sidebar-field mt-2">
                <label>Barrier Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="CLOSED">Closed Only (Normal)</option>
                  <option value="EXTENDED_DELAY">Extended Delays (&gt;15m)</option>
                  <option value="OPEN">Currently Open</option>
                </select>
              </div>

              <div className="sidebar-field mt-2">
                <label>Operational Shift</label>
                <select
                  value={filterShift}
                  onChange={(e) => setFilterShift(e.target.value)}
                >
                  <option value="ALL">All 24 Hours</option>
                  <option value="MORNING">Morning (06:00 - 14:00)</option>
                  <option value="EVENING">Evening (14:00 - 22:00)</option>
                  <option value="NIGHT">Night (22:00 - 06:00)</option>
                </select>
              </div>

              {/* Keyword Search */}
              <div className="sidebar-field mt-2">
                <label>Search Keyword</label>
                <div className="sidebar-input-with-icon">
                  <FaSearch className="icon" />
                  <input
                    type="text"
                    placeholder="Search LC# or location..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') fetchRecordsData(); }}
                  />
                </div>
              </div>

              {/* Sort Order */}
              <div className="sidebar-field mt-2">
                <label>Sort By</label>
                <div className="sidebar-sort-group">
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                  >
                    <option value="openedAt">Opened Time</option>
                    <option value="closedAt">Closed Time</option>
                    <option value="durationSeconds">Duration</option>
                    <option value="lcNumber">LC Number</option>
                    <option value="status">Status</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn-outline sidebar-sort-btn"
                    onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                    title={`Order: ${sortOrder.toUpperCase()}`}
                  >
                    {sortOrder === 'asc' ? <FaSortAmountUp /> : <FaSortAmountDown />}
                  </button>
                </div>
              </div>
            </div>

            {/* SECTION 4: Select Columns */}
            <div className="sidebar-section">
              <div className="section-head-row">
                <span className="section-title">
                  <FaColumns className="mr-1 text-primary" /> Report Columns
                </span>
                <div className="section-quick-links">
                  <button type="button" onClick={handleSelectAllColumns}>All</button>
                  <span className="sep">|</span>
                  <button type="button" onClick={handleResetDefaultColumns}>Reset</button>
                </div>
              </div>

              <div className="sidebar-columns-checkboxes">
                {REPORT_COLUMNS.map(col => {
                  const isChecked = selectedExportColumns.includes(col.key);
                  return (
                    <label key={col.key} className="sidebar-col-label">
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
          </div>

          {/* SIDEBAR FOOTER: ACTION BUTTONS (Pinned at bottom of builder column) */}
          <div className="sidebar-action-footer">
            <button
              type="button"
              className="btn btn-primary btn-block view-btn"
              onClick={() => fetchRecordsData()}
              disabled={loadingRecords}
            >
              <FaEye />
              <span>{loadingRecords ? 'Loading...' : 'View Log / Preview'}</span>
            </button>

            <div className="export-buttons-pair mt-2">
              <button
                type="button"
                className="btn btn-success btn-sm export-btn"
                onClick={() => handleDownloadReport('xlsx')}
                disabled={isExporting || selectedExportColumns.length === 0}
                title="Download Excel report"
              >
                <FaFileExcel />
                <span>Excel (.xlsx)</span>
              </button>

              <button
                type="button"
                className="btn btn-danger btn-sm export-btn"
                onClick={() => handleDownloadReport('pdf')}
                disabled={isExporting || selectedExportColumns.length === 0}
                title="Download PDF report"
              >
                <FaFilePdf />
                <span>PDF (.pdf)</span>
              </button>
            </div>
          </div>
        </aside>

        {/* ═══════════════════════════════════════════════════════════
            RIGHT COLUMN: VIEW LOG MAIN WORKSPACE
           ═══════════════════════════════════════════════════════════ */}
        <main className="view-log-main-card">
          <div className="view-log-header">
            <div>
              <div className="log-title-row">
                <FaEye className="text-primary mr-2" />
                <h3 className="log-title">View Log: Operational Logsheet Records</h3>
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

              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => window.print()}
                title="Print current logsheet"
              >
                <FaPrint />
                <span>Print</span>
              </button>
            </div>
          </div>

          {/* Table Container */}
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
                      <FaSyncAlt className="spin mr-2" /> Loading operational records...
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={selectedExportColumns.length || 1} className="text-center py-5 empty-cell">
                      <FaArchway size={36} className="mb-2 text-muted" />
                      <p style={{ margin: 0, fontWeight: 700, fontSize: '1rem', color: '#334155' }}>
                        No operational records found for this selection.
                      </p>
                      <small className="text-muted">
                        Please select at least one cluster/gate or widen your date range in the left builder panel.
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
