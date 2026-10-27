import { useState, useEffect, useMemo } from 'react';
import {
  FaArchway,
  FaCalendarAlt,
  FaChartBar,
  FaCheckCircle,
  FaClock,
  FaDownload,
  FaExclamationTriangle,
  FaFileAlt,
  FaFileExcel,
  FaFilePdf,
  FaFilter,
  FaLayerGroup,
  FaPrint,
  FaSearch,
  FaSortAmountDown,
  FaSortAmountUp,
  FaSyncAlt,
  FaTimes,
  FaCheck
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
  openedBy?: string | null;
  closedBy?: string | null;
  trainNumber?: string | null;
  remarks?: string | null;
}

const authHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
});

const REPORT_COLUMNS = [
  { key: 'scopeGroup', label: 'Cluster / Scope Group' },
  { key: 'lcNumber', label: 'LC Number' },
  { key: 'locationName', label: 'Location Name' },
  { key: 'zone', label: 'Zone' },
  { key: 'division', label: 'Division' },
  { key: 'openedDate', label: 'Date' },
  { key: 'openedTime', label: 'Opened Time (IST)' },
  { key: 'closedTime', label: 'Closed Time (IST)' },
  { key: 'durationFormatted', label: 'Duration' },
  { key: 'status', label: 'Status' },
  { key: 'openedBy', label: 'Source / Operator' },
  { key: 'trainNumber', label: 'Train Movement' },
  { key: 'remarks', label: 'Remarks' },
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

  // 4. Operational Records & KPI Metrics State
  const [records, setRecords] = useState<OperationalRecord[]>([]);
  const [metrics, setMetrics] = useState<any>({
    totalOperations: 0,
    totalDurationSeconds: 0,
    totalDurationFormatted: '0s',
    avgDurationSeconds: 0,
    avgDurationFormatted: '0s',
    extendedDelaysCount: 0,
    currentlyOpenCount: 0,
    reportingGatesCount: 0
  });
  const [loadingRecords, setLoadingRecords] = useState<boolean>(false);

  // Pagination
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // 5. Generate Report Modal State
  const [showGenerateModal, setShowGenerateModal] = useState<boolean>(false);
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'pdf'>('xlsx');
  const [selectedExportColumns, setSelectedExportColumns] = useState<string[]>(
    REPORT_COLUMNS.map(c => c.key)
  );
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

      // Initial Fetch
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
      setMetrics({
        totalOperations: 0,
        totalDurationFormatted: '0s',
        avgDurationFormatted: '0s',
        extendedDelaysCount: 0,
        currentlyOpenCount: 0,
        reportingGatesCount: 0
      });
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
        setMetrics(data.metrics || {});
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

  // Download Report Trigger
  const handleDownloadReport = async () => {
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
      url.searchParams.append('format', exportFormat);
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
      const ext = exportFormat === 'xlsx' ? 'xlsx' : 'pdf';
      const downloadFilename = `LC_Report_${startDateStr}_to_${endDateStr}.${ext}`;

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      toastSuccess(`Report exported successfully as .${ext}!`, 'Download Completed');
      setShowGenerateModal(false);
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
              <h2 className="reports-main-heading">Level Crossing Operational Reports</h2>
              <p className="reports-sub-heading">
                Step-by-step reporting: select clusters & gates, set date range filters, and view audit logsheets.
              </p>
            </div>
          </div>

          <div className="reports-header-actions">
            <button
              className="btn btn-secondary"
              onClick={() => fetchRecordsData()}
              disabled={loadingRecords}
              title="Refresh current data view"
            >
              <FaSyncAlt className={loadingRecords ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              className="btn btn-success generate-btn"
              onClick={() => setShowGenerateModal(true)}
            >
              <FaDownload />
              <span>Generate Report</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── STEP 1: SCOPE GROUP & GATE SELECTION (Full Width Card) ── */}
      <div className="card workflow-step-card">
        <div className="step-badge-row">
          <span className="step-pill">STEP 1</span>
          <h3 className="step-title">Select Scope Groups (Clusters) & Level Crossing Gates</h3>
        </div>

        {loadingClusters ? (
          <div className="p-4 text-center text-muted">
            <FaSyncAlt className="spin mr-2" /> Loading clusters and gates hierarchy...
          </div>
        ) : (
          <div className="scope-selection-grid">
            {/* Cluster Multi-Selector Block */}
            <div className="scope-block">
              <div className="scope-block-header">
                <div className="scope-title-badge">
                  <FaLayerGroup />
                  <span>Scope Groups / Clusters</span>
                  <span className="count-pill">{selectedClusterIds.length} of {clusters.length}</span>
                </div>
                <div className="block-quick-links">
                  <button type="button" onClick={handleSelectAllClusters}>Select All</button>
                  <span className="sep">|</span>
                  <button type="button" onClick={handleClearAllClusters}>Clear</button>
                </div>
              </div>

              <div className="cluster-chips-wrap">
                {clusters.map(c => {
                  const isSelected = selectedClusterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`cluster-choice-chip ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleToggleCluster(c.id)}
                    >
                      <span className="cluster-dot" style={{ backgroundColor: c.color || '#0B3C7A' }} />
                      <span className="chip-name">{c.name}</span>
                      <span className="chip-gate-count">{c.gates.length} gates</span>
                      {isSelected && <FaCheck className="chip-check" size={11} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Gates Multi-Selector Block */}
            <div className="scope-block">
              <div className="scope-block-header">
                <div className="scope-title-badge">
                  <FaArchway />
                  <span>Level Crossing Gates</span>
                  <span className="count-pill">{selectedGateIds.length} of {availableGates.length}</span>
                </div>
                <div className="block-quick-links">
                  <button type="button" onClick={handleSelectAllAvailableGates}>All Gates</button>
                  <span className="sep">|</span>
                  <button type="button" onClick={handleClearGates}>Clear</button>
                </div>
              </div>

              {availableGates.length > 6 && (
                <div className="gate-search-box">
                  <FaSearch size={12} className="text-muted" />
                  <input
                    type="text"
                    placeholder="Quick search LC number or station..."
                    value={gateSearchText}
                    onChange={(e) => setGateSearchText(e.target.value)}
                  />
                  {gateSearchText && (
                    <button type="button" className="clear-btn" onClick={() => setGateSearchText('')}>
                      <FaTimes size={10} />
                    </button>
                  )}
                </div>
              )}

              <div className="gate-chips-wrap">
                {filteredAvailableGates.length === 0 ? (
                  <div className="text-muted small py-2">
                    {availableGates.length === 0 ? 'Select a cluster above to see gates' : 'No gates match search'}
                  </div>
                ) : (
                  filteredAvailableGates.map(g => {
                    const isSelected = selectedGateIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        className={`gate-choice-chip ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleToggleGate(g.id)}
                        title={`${g.lcNumber} - ${g.locationName} (${g.clusterName})`}
                      >
                        <strong className="gate-lc">{g.lcNumber}</strong>
                        <span className="gate-loc">{g.locationName}</span>
                        {isSelected && <FaCheck className="chip-check" size={10} />}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── STEP 2: DATE RANGE & OPERATIONAL FILTERS (Full Width Card) ── */}
      <div className="card workflow-step-card">
        <div className="step-badge-row">
          <span className="step-pill">STEP 2</span>
          <h3 className="step-title">Date Range & Operational Filters</h3>
        </div>

        {/* Quick Date Range Presets */}
        <div className="presets-row">
          <span className="preset-label">Date Window:</span>
          <div className="preset-pills">
            <button
              type="button"
              className={`preset-pill ${datePreset === '7days' ? 'active' : ''}`}
              onClick={() => applyDatePreset('7days')}
            >
              Last 7 Days
            </button>
            <button
              type="button"
              className={`preset-pill ${datePreset === 'today' ? 'active' : ''}`}
              onClick={() => applyDatePreset('today')}
            >
              Today
            </button>
            <button
              type="button"
              className={`preset-pill ${datePreset === 'yesterday' ? 'active' : ''}`}
              onClick={() => applyDatePreset('yesterday')}
            >
              Yesterday
            </button>
            <button
              type="button"
              className={`preset-pill ${datePreset === '30days' ? 'active' : ''}`}
              onClick={() => applyDatePreset('30days')}
            >
              Last 30 Days
            </button>
            <button
              type="button"
              className={`preset-pill ${datePreset === 'month' ? 'active' : ''}`}
              onClick={() => applyDatePreset('month')}
            >
              This Month
            </button>
          </div>
        </div>

        {/* Responsive Filters Grid */}
        <div className="filters-inputs-grid">
          <div className="filter-field">
            <label>Start Date</label>
            <div className="input-with-icon">
              <FaCalendarAlt className="field-icon" />
              <input
                type="date"
                value={startDateStr}
                onChange={(e) => {
                  setStartDateStr(e.target.value);
                  setDatePreset('custom');
                }}
              />
            </div>
          </div>

          <div className="filter-field">
            <label>End Date</label>
            <div className="input-with-icon">
              <FaCalendarAlt className="field-icon" />
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

          <div className="filter-field">
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

          <div className="filter-field">
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

          <div className="filter-field search-field">
            <label>Keyword Search</label>
            <div className="input-with-icon">
              <FaSearch className="field-icon" />
              <input
                type="text"
                placeholder="Search LC#, station, operator..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') fetchRecordsData(); }}
              />
            </div>
          </div>

          <div className="filter-field sort-field">
            <label>Sort Order</label>
            <div className="sort-input-group">
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
                className="btn btn-outline sort-toggle-btn"
                onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                title={`Order: ${sortOrder.toUpperCase()}`}
              >
                {sortOrder === 'asc' ? <FaSortAmountUp /> : <FaSortAmountDown />}
              </button>
            </div>
          </div>
        </div>

        {/* Apply Trigger Button */}
        <div className="filter-apply-row">
          <div className="active-summary-tag">
            <span>Filtering:</span>
            <strong>{startDateStr} ➔ {endDateStr}</strong>
            <span className="dot">•</span>
            <span>{selectedClusterIds.length} Clusters</span>
            <span className="dot">•</span>
            <span>{selectedGateIds.length} Gates</span>
          </div>

          <button
            type="button"
            className="btn btn-primary apply-filter-btn"
            onClick={() => fetchRecordsData()}
            disabled={loadingRecords}
          >
            <FaFilter />
            <span>Apply Filters</span>
          </button>
        </div>
      </div>

      {/* ── STEP 3: EXECUTIVE KPI METRIC CARDS (Full Width Grid) ── */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-icon-wrapper blue">
            <FaChartBar />
          </div>
          <div className="kpi-content">
            <span className="kpi-label">TOTAL OPERATIONS</span>
            <span className="kpi-value">{metrics.totalOperations}</span>
            <span className="kpi-subtext">Across {metrics.reportingGatesCount} reporting gates</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper teal">
            <FaClock />
          </div>
          <div className="kpi-content">
            <span className="kpi-label">TOTAL OPEN DURATION</span>
            <span className="kpi-value">{metrics.totalDurationFormatted}</span>
            <span className="kpi-subtext">Cumulative road open time</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper purple">
            <FaCheckCircle />
          </div>
          <div className="kpi-content">
            <span className="kpi-label">AVG CLEARANCE PACE</span>
            <span className="kpi-value">{metrics.avgDurationFormatted}</span>
            <span className="kpi-subtext">Per barrier operation</span>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-wrapper amber">
            <FaExclamationTriangle />
          </div>
          <div className="kpi-content">
            <span className="kpi-label">EXTENDED DELAYS</span>
            <span className="kpi-value">{metrics.extendedDelaysCount}</span>
            <span className="kpi-subtext">Gate held open &gt; 15 mins</span>
          </div>
        </div>
      </div>

      {/* ── STEP 4: VIEW LOG (Operational Logsheet Records Table) ── */}
      <div className="card table-card">
        <div className="table-header-row">
          <div>
            <div className="table-title-group">
              <span className="step-pill">STEP 3</span>
              <h3 className="table-title">View Log: Operational Logsheet Records</h3>
            </div>
            <span className="table-subtitle">
              Displaying {records.length} events from {startDateStr} to {endDateStr}
            </span>
          </div>

          <div className="table-controls-right">
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

        <div className="table-responsive">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Cluster</th>
                <th>LC Number</th>
                <th>Location</th>
                <th>Date</th>
                <th>Opened (IST)</th>
                <th>Closed (IST)</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Source / Operator</th>
                <th>Train / Action</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {loadingRecords ? (
                <tr>
                  <td colSpan={11} className="text-center py-5">
                    <FaSyncAlt className="spin mr-2" /> Loading operational logs...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-5 empty-cell">
                    <FaArchway size={36} className="mb-2 text-muted" />
                    <p style={{ margin: 0, fontWeight: 700, fontSize: '1rem', color: '#334155' }}>
                      No operational records found for this selection.
                    </p>
                    <small className="text-muted">
                      Please select at least one cluster/gate or widen your date range.
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
                      <td>
                        <span
                          className="cluster-tag"
                          style={{ borderColor: rec.scopeGroupColor, color: rec.scopeGroupColor }}
                        >
                          {rec.scopeGroupName}
                        </span>
                      </td>
                      <td>
                        <strong className="lc-tag">{rec.lcNumber}</strong>
                      </td>
                      <td>{rec.locationName}</td>
                      <td>{openedDateStr}</td>
                      <td className="text-mono">{openedTimeStr}</td>
                      <td className="text-mono">{closedTimeStr}</td>
                      <td>
                        <span className="duration-pill">{rec.durationFormatted}</span>
                      </td>
                      <td>
                        <span className={`status-badge ${rec.status.toLowerCase()}`}>
                          {rec.status}
                        </span>
                      </td>
                      <td>
                        <span className="operator-text">{rec.openedBy || '-'}</span>
                      </td>
                      <td>{rec.trainNumber || '-'}</td>
                      <td className="remarks-cell" title={rec.remarks || ''}>
                        {rec.remarks || '-'}
                      </td>
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
              <span className="page-indicator">Page {currentPage} of {totalPages}</span>
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
      </div>

      {/* ── Generate Report Modal Dialog ─────────────────────────── */}
      {showGenerateModal && (
        <div className="modal-backdrop" onClick={() => setShowGenerateModal(false)}>
          <div className="modal-content generate-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-group">
                <FaFileAlt className="modal-icon" />
                <h3>Generate Operational Audit Report</h3>
              </div>
              <button
                type="button"
                className="close-btn"
                onClick={() => setShowGenerateModal(false)}
              >
                <FaTimes />
              </button>
            </div>

            <div className="modal-body">
              {/* Active Filter Summary Box */}
              <div className="export-summary-box">
                <div className="summary-item">
                  <span className="lbl">Date Range:</span>
                  <strong className="val">{startDateStr} to {endDateStr}</strong>
                </div>
                <div className="summary-item">
                  <span className="lbl">Scope Groups:</span>
                  <strong className="val">{selectedClusterIds.length} Clusters Selected</strong>
                </div>
                <div className="summary-item">
                  <span className="lbl">LC Gates:</span>
                  <strong className="val">{selectedGateIds.length} Gates Selected</strong>
                </div>
                <div className="summary-item">
                  <span className="lbl">Matching Records:</span>
                  <strong className="val">{records.length} Operational Events</strong>
                </div>
              </div>

              {/* Format Selection Cards */}
              <label className="section-label">Select Report Document Format</label>
              <div className="format-selection-grid">
                <div
                  className={`format-card ${exportFormat === 'xlsx' ? 'active' : ''}`}
                  onClick={() => setExportFormat('xlsx')}
                >
                  <FaFileExcel className="format-icon excel" />
                  <div className="format-info">
                    <strong>Excel Spreadsheet (.xlsx)</strong>
                    <p>Tabular dataset with KPI headers, cell styling, auto-column widths, and status colors.</p>
                  </div>
                  <div className="format-radio">
                    <input
                      type="radio"
                      name="exportFormat"
                      checked={exportFormat === 'xlsx'}
                      onChange={() => setExportFormat('xlsx')}
                    />
                  </div>
                </div>

                <div
                  className={`format-card ${exportFormat === 'pdf' ? 'active' : ''}`}
                  onClick={() => setExportFormat('pdf')}
                >
                  <FaFilePdf className="format-icon pdf" />
                  <div className="format-info">
                    <strong>PDF Document (.pdf)</strong>
                    <p>Official printable Railway logsheet with executive KPI boxes, pagination, and timestamps.</p>
                  </div>
                  <div className="format-radio">
                    <input
                      type="radio"
                      name="exportFormat"
                      checked={exportFormat === 'pdf'}
                      onChange={() => setExportFormat('pdf')}
                    />
                  </div>
                </div>
              </div>

              {/* Column Inclusion Selector */}
              <div className="columns-selector-section">
                <div className="columns-header">
                  <label className="section-label mb-0">Select Columns to Include</label>
                  <div className="tree-quick-actions">
                    <button
                      type="button"
                      className="text-link-btn"
                      onClick={() => setSelectedExportColumns(REPORT_COLUMNS.map(c => c.key))}
                    >
                      Select All
                    </button>
                    <span className="divider">|</span>
                    <button
                      type="button"
                      className="text-link-btn"
                      onClick={() => setSelectedExportColumns(['lcNumber', 'locationName', 'openedDate', 'openedTime', 'closedTime', 'durationFormatted', 'status'])}
                    >
                      Reset Default
                    </button>
                  </div>
                </div>

                <div className="columns-checkbox-grid">
                  {REPORT_COLUMNS.map(col => {
                    const isChecked = selectedExportColumns.includes(col.key);
                    return (
                      <label key={col.key} className="column-checkbox-item">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            if (isChecked) {
                              if (selectedExportColumns.length > 1) {
                                setSelectedExportColumns(prev => prev.filter(k => k !== col.key));
                              } else {
                                toastInfo('At least one column must be selected');
                              }
                            } else {
                              setSelectedExportColumns(prev => [...prev, col.key]);
                            }
                          }}
                        />
                        <span>{col.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowGenerateModal(false)}
                disabled={isExporting}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn btn-success download-action-btn ${exportFormat}`}
                onClick={handleDownloadReport}
                disabled={isExporting || selectedExportColumns.length === 0}
              >
                {isExporting ? (
                  <>
                    <FaSyncAlt className="spin" />
                    <span>Generating {exportFormat.toUpperCase()}...</span>
                  </>
                ) : (
                  <>
                    <FaDownload />
                    <span>Download {exportFormat === 'xlsx' ? 'Excel (.xlsx)' : 'PDF (.pdf)'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
