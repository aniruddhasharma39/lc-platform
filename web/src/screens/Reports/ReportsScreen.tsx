import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  FaChevronUp,
  FaListAlt,
  FaRetweet,
  FaClock,
  FaHourglassHalf,
  FaRoad,
  FaChartLine,
  FaCalculator,
  FaFileCsv,
} from 'react-icons/fa';
import type { User } from '../../types';
import { API_URL } from '../../config';
import { useToast } from '../../context/ToastContext';
import {
  reportsCacheService,
  type OperationalRecord,
  type ClusterItem,
  type ClusterGate,
  type AuthoritativeReportMetrics,
  type ReportsCursor,
  type ReportFilterParams,
} from '../../services/reportsCacheService';
import './ReportsScreen.css';

export interface DailyCycleMetric {
  dateStr: string;
  dateFormatted: string;
  completedCycles: number;
  avgClosingSeconds: number;
  avgClosingFormatted: string;
  avgOpeningSeconds: number;
  avgOpeningFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
}

export interface GateCycleReport {
  gate: {
    id: number;
    lcNumber: string;
    name: string | null;
    locationName: string;
    zone: string | null;
    division: string | null;
    scopeGroupName?: string | null;
  };
  kpis: {
    totalCycles: number;
    avgClosingSeconds: number;
    avgClosingFormatted: string;
    avgOpeningSeconds: number;
    avgOpeningFormatted: string;
    totalClosedSeconds: number;
    totalClosedFormatted: string;
    totalOpenSeconds: number;
    totalOpenFormatted: string;
  };
  dailyBreakdown: DailyCycleMetric[];
}


export interface GateCountItem {
  gateId: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  zone: string | null;
  division: string | null;
  stationId: number | null;
  stationName: string | null;
  stationCode: string | null;
  openCount: number;
  closeCount: number;
  totalOperations: number;
}

export interface StationCountItem {
  stationId: number | null;
  stationName: string;
  stationCode: string;
  zone: string;
  division: string;
  gatesCount: number;
  openCount: number;
  closeCount: number;
  totalOperations: number;
  gates: GateCountItem[];
}

export interface DivisionCountItem {
  division: string;
  zone: string;
  stationCount: number;
  gatesCount: number;
  openCount: number;
  closeCount: number;
  totalOperations: number;
  stations: StationCountItem[];
}

export interface CountReportResponse {
  startDate: string;
  endDate: string;
  kpis: {
    totalOperations: number;
    totalOpenCount: number;
    totalCloseCount: number;
    reportingGatesCount: number;
    peakOperationGate: {
      lcNumber: string;
      operations: number;
      locationName: string;
    } | null;
  };
  gates: GateCountItem[];
  stations: StationCountItem[];
  divisions: DivisionCountItem[];
}

export interface HolisticLCItem {
  gateId: number;
  lcNumber: string;
  name: string | null;
  locationName: string;
  stationName: string | null;
  stationCode: string | null;
  division: string | null;
  zone: string | null;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
}

export interface HolisticStationItem {
  stationId: number | null;
  stationName: string;
  stationCode: string;
  division: string;
  zone: string;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  gates: HolisticLCItem[];
}

export interface HolisticDivisionItem {
  division: string;
  zone: string;
  stationCount: number;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  stations: HolisticStationItem[];
}

export interface HolisticZoneItem {
  zone: string;
  divisionCount: number;
  stationCount: number;
  gatesCount: number;
  totalOperations: number;
  openCount: number;
  closeCount: number;
  totalOpenSeconds: number;
  totalOpenFormatted: string;
  avgOpenSeconds: number;
  avgOpenFormatted: string;
  totalClosedSeconds: number;
  totalClosedFormatted: string;
  extendedDelaysCount: number;
  divisions: HolisticDivisionItem[];
}

export interface HolisticReportResponse {
  startDate: string;
  endDate: string;
  kpis: {
    totalZones: number;
    totalDivisions: number;
    totalStations: number;
    totalGates: number;
    totalOperations: number;
    totalOpenSeconds: number;
    totalOpenFormatted: string;
    avgOpenSeconds: number;
    avgOpenFormatted: string;
    totalClosedSeconds: number;
    totalClosedFormatted: string;
    totalExtendedDelays: number;
  };
  hierarchy: HolisticZoneItem[];
  flatStations: HolisticStationItem[];
  flatGates: HolisticLCItem[];
}

export interface FullCycleAnalyticsResponse {
  startDate: string;
  endDate: string;
  overall: {
    totalCycles: number;
    avgClosingSeconds: number;
    avgClosingFormatted: string;
    avgOpeningSeconds: number;
    avgOpeningFormatted: string;
    totalClosedSeconds: number;
    totalClosedFormatted: string;
    totalOpenSeconds: number;
    totalOpenFormatted: string;
    reportingGatesCount: number;
  };
  gateReports: GateCycleReport[];
}

type Props = {
  user: User;
};

const authHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
});

// Clean column definitions
const REPORT_COLUMNS = [
  { key: 'lcNumber', label: 'LC Number' },
  { key: 'masterUnit', label: 'Master Unit' },
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

  // 5. Operational Records & Caching State
  const [reportType, setReportType] = useState<'count' | 'duration' | 'holistic' | 'complete_log'>('count');
  const [countData, setCountData] = useState<CountReportResponse | null>(null);
  const [loadingCountData, setLoadingCountData] = useState<boolean>(false);
  const [countSubView, setCountSubView] = useState<'by_gate' | 'by_station' | 'by_division'>('by_gate');

  const [holisticData, setHolisticData] = useState<HolisticReportResponse | null>(null);
  const [loadingHolisticData, setLoadingHolisticData] = useState<boolean>(false);
  const [holisticSubView, setHolisticSubView] = useState<'hierarchy' | 'stations' | 'gates'>('hierarchy');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [cycleData, setCycleData] = useState<FullCycleAnalyticsResponse | null>(null);
  const [loadingCycleData, setLoadingCycleData] = useState<boolean>(false);
  const [selectedCycleGateId, setSelectedCycleGateId] = useState<number | 'ALL'>('ALL');

  const [records, setRecords] = useState<OperationalRecord[]>([]);
  const [metrics, setMetrics] = useState<AuthoritativeReportMetrics | null>(null);
  const [cursor, setCursor] = useState<ReportsCursor | null>(null);
  const [loadingRecords, setLoadingRecords] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'updating' | 'outdated'>('synced');
  const [isScopeVerified, setIsScopeVerified] = useState<boolean>(false);

  // Pagination & Export
  const [rowsPerPage, setRowsPerPage] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportStage, setExportStage] = useState<string>('');
  const [exportFormat, setExportFormat] = useState<string>('');

  const gateDropdownRef = useRef<HTMLDivElement>(null);
  const columnPopoverRef = useRef<HTMLDivElement>(null);

  // Synchronization refs to prevent overlapping requests and race conditions
  const isRevalidatingRef = useRef<boolean>(false);
  const isPollingRef = useRef<boolean>(false);
  const currentParamsRef = useRef<ReportFilterParams | null>(null);
  const currentCursorRef = useRef<ReportsCursor | null>(null);
  const activeRecordsRef = useRef<OperationalRecord[]>([]);

  // Keep refs in sync with current state
  currentCursorRef.current = cursor;
  activeRecordsRef.current = records;

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

  // 1. Fetch Clusters (Hierarchy Caching with Online Authorization Scope Verification)
  const fetchClusters = useCallback(async (forceReload = false) => {
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const cachedHierarchy = reportsCacheService.getCachedHierarchy(user.id);

    // If offline, gracefully fall back immediately to cached hierarchy with outdated status
    if (!isOnline && cachedHierarchy) {
      setClusters(cachedHierarchy.clusters);
      setLoadingClusters(false);
      setIsScopeVerified(true);
      if (selectedClusterIds.length === 0) {
        const allCIds = cachedHierarchy.clusters.map(c => c.id);
        const allGIds = Array.from(new Set(cachedHierarchy.clusters.flatMap(c => c.gates.map(g => g.id))));
        setSelectedClusterIds(allCIds);
        setSelectedGateIds(allGIds);
      }
      setSyncStatus('outdated');
      return;
    }

    if (!cachedHierarchy) {
      setLoadingClusters(true);
    }

    // When online: validate current authorization / scope revision before displaying cached data
    try {
      const headers: Record<string, string> = { ...authHeaders() };
      if (cachedHierarchy?.etag && !forceReload) {
        headers['If-None-Match'] = cachedHierarchy.etag;
      }

      const res = await fetch(`${API_URL}/api/v1/reports/clusters`, { headers });

      // Handle HTTP 304 Not Modified: scope confirmed unchanged!
      if (res.status === 304 && cachedHierarchy) {
        reportsCacheService.touchHierarchyVerified(user.id);
        setClusters(cachedHierarchy.clusters);
        setIsScopeVerified(true);
        if (selectedClusterIds.length === 0) {
          const allCIds = cachedHierarchy.clusters.map(c => c.id);
          const allGIds = Array.from(new Set(cachedHierarchy.clusters.flatMap(c => c.gates.map(g => g.id))));
          setSelectedClusterIds(allCIds);
          setSelectedGateIds(allGIds);
        }
        return;
      }

      if (!res.ok) {
        if (res.status === 403) {
          toastError('No clusters are assigned to your user account.');
        }
        return;
      }

      const data = await res.json();
      const clusterList: ClusterItem[] = data.clusters || [];
      const etag = res.headers.get('ETag') || data.directoryRevisionToken;

      // Permission Revocation Security Check:
      // If cached hierarchy existed and etag differs or accessible gates shrunk:
      if (cachedHierarchy) {
        const prevGateIds = new Set(cachedHierarchy.clusters.flatMap(c => c.gates.map(g => g.id)));
        const newGateIds = new Set(clusterList.flatMap(c => c.gates.map(g => g.id)));
        const hasRevocations = Array.from(prevGateIds).some(id => !newGateIds.has(id));
        if (hasRevocations || etag !== cachedHierarchy.etag) {
          console.info('[ReportsScreen] Scope changed or gate access revoked. Purging cached report records for user.');
          reportsCacheService.clearUserCache(user.id);
        }
      }

      reportsCacheService.saveHierarchy(user.id, clusterList, !!data.isDeveloper, etag);
      setClusters(clusterList);
      setIsScopeVerified(true);

      const allClusterIds = clusterList.map(c => c.id);
      const allGateIds = Array.from(new Set(clusterList.flatMap(c => c.gates.map(g => g.id))));

      setSelectedClusterIds(prev => prev.length === 0 ? allClusterIds : prev.filter(id => allClusterIds.includes(id)));
      setSelectedGateIds(prev => prev.length === 0 ? allGateIds : prev.filter(id => allGateIds.includes(id)));
    } catch (err) {
      console.warn('[ReportsScreen] Error revalidating clusters hierarchy (offline fallback):', err);
      if (cachedHierarchy) {
        setClusters(cachedHierarchy.clusters);
        setIsScopeVerified(true);
        setSyncStatus('outdated');
      }
    } finally {
      setLoadingClusters(false);
    }
  }, [user.id, selectedClusterIds.length, toastError]);

  useEffect(() => {
    fetchClusters();
  }, [fetchClusters]);

  // 2. Core Fetch Records Data with SWR & Two-Level LRU Caching
  const fetchRecordsData = useCallback(async (
    targetClusterIds = selectedClusterIds,
    targetGateIds = selectedGateIds,
    start = startDateStr,
    end = endDateStr,
    search = debouncedSearch,
    options: { forceReload?: boolean } = {}
  ) => {
    if ((targetClusterIds.length === 0 && !isDeveloper) || targetGateIds.length === 0) {
      setRecords([]);
      setMetrics(null);
      setCursor(null);
      setSyncStatus('synced');
      return;
    }

    const filterParams: ReportFilterParams = {
      scopeGroupIds: targetClusterIds.length > 0 ? targetClusterIds : (isDeveloper ? 'all' : []),
      gateIds: targetGateIds.length > 0 ? targetGateIds : (isDeveloper ? 'all' : []),
      startDate: start,
      endDate: end,
      status: filterStatus,
      shift: filterShift,
      search: search,
      sortBy: sortBy,
      sortOrder: sortOrder,
    };

    currentParamsRef.current = filterParams;

    // Scope verification barrier: When online, do not render cached records until scope is confirmed
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    if (isOnline && !isScopeVerified) {
      setLoadingRecords(true);
      return;
    }

    // A. Check Two-Level Cache (Memory first, then Persistent localStorage)
    const cachedResult = reportsCacheService.getCachedReport(user.id, filterParams);
    const hasCache = !!cachedResult.entry;

    if (hasCache) {
      const entry = cachedResult.entry!;
      setRecords(entry.records);
      setMetrics(entry.authoritativeMetrics);
      setCursor(entry.cursor);
      setLoadingRecords(false);

      // If cache is fresh (< 2min) and not manual force-reload, skip network request entirely!
      if (cachedResult.isFresh && !options.forceReload) {
        setSyncStatus('synced');
        return;
      }
    } else {
      // First visit: Show table loading state
      setLoadingRecords(true);
    }

    // B. Background Revalidation (Conditional HTTP 304 via ETag)
    if (isRevalidatingRef.current) return;
    isRevalidatingRef.current = true;
    setSyncStatus('updating');

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

      const headers: Record<string, string> = { ...authHeaders() };
      if (hasCache && cachedResult.entry?.etag && !options.forceReload) {
        headers['If-None-Match'] = cachedResult.entry.etag;
      }

      const res = await fetch(url.toString(), { headers });

      // Handle HTTP 304 Not Modified: Cache is authoritative!
      if (res.status === 304) {
        const serverETag = res.headers.get('ETag') || undefined;
        reportsCacheService.touchVerified(user.id, filterParams, serverETag);
        setSyncStatus('synced');
        return;
      }

      // Handle HTTP 200 OK: Cache miss or data changed
      if (res.ok) {
        const data = await res.json();
        const serverETag = res.headers.get('ETag');
        const newRecords: OperationalRecord[] = data.records || [];
        const newMetrics: AuthoritativeReportMetrics | null = data.metrics || null;
        const newCursor: ReportsCursor = data.cursor || {
          eventCursorTime: new Date(0).toISOString(),
          eventCursorId: 0,
          tombstoneCursorId: '0',
          gateRevisions: {},
          serverTime: new Date().toISOString(),
        };

        // Store into Two-Level LRU Cache
        reportsCacheService.saveReport(user.id, filterParams, {
          records: newRecords,
          metrics: newMetrics,
          etag: serverETag,
          cursor: newCursor,
        });

        setRecords(newRecords);
        setMetrics(newMetrics);
        setCursor(newCursor);
        setCurrentPage(1);
        setSyncStatus('synced');
      } else {
        const err = await res.json().catch(() => ({}));
        if (!hasCache) {
          toastError(err.error || 'Failed to load records');
        }
        setSyncStatus(hasCache ? 'outdated' : 'synced');
      }
    } catch (err) {
      console.warn('[ReportsScreen] Revalidation network error:', err);
      if (!hasCache) {
        toastError('Network error loading reports');
      }
      setSyncStatus(hasCache ? 'outdated' : 'synced');
    } finally {
      setLoadingRecords(false);
      isRevalidatingRef.current = false;
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
    debouncedSearch,
    isDeveloper,
    user.id,
    isScopeVerified,
    toastError
  ]);

  // ── REACTIVE TRIGGER ON FILTER CHANGES ──────────────────────────────────
  useEffect(() => {
    if (clusters.length > 0 && isScopeVerified) {
      fetchRecordsData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr, debouncedSearch);
    }
  }, [
    fetchRecordsData,
    clusters.length,
    isScopeVerified,
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


  // ── COUNT REPORT DATA FETCHING ──────────────────────────────────────────
  const fetchCountData = useCallback(async (
    targetGateIds: number[],
    start: string,
    end: string
  ) => {
    if (targetGateIds.length === 0) {
      setCountData(null);
      return;
    }
    setLoadingCountData(true);
    try {
      const url = new URL(`${API_URL}/api/v1/reports/count`);
      if (targetGateIds.length > 0) {
        url.searchParams.append('gateIds', targetGateIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('gateIds', 'all');
      }
      url.searchParams.append('startDate', start);
      url.searchParams.append('endDate', end);

      const res = await fetch(url.toString(), { headers: authHeaders() });
      if (res.ok) {
        const json: CountReportResponse = await res.json();
        setCountData(json);
      }
    } catch (err) {
      console.error('Failed to fetch count report:', err);
    } finally {
      setLoadingCountData(false);
    }
  }, [isDeveloper]);

  // ── HOLISTIC REPORT DATA FETCHING ────────────────────────────────────────
  const fetchHolisticData = useCallback(async (
    targetGateIds: number[],
    start: string,
    end: string
  ) => {
    if (targetGateIds.length === 0) {
      setHolisticData(null);
      return;
    }
    setLoadingHolisticData(true);
    try {
      const url = new URL(`${API_URL}/api/v1/reports/holistic`);
      if (targetGateIds.length > 0) {
        url.searchParams.append('gateIds', targetGateIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('gateIds', 'all');
      }
      url.searchParams.append('startDate', start);
      url.searchParams.append('endDate', end);

      const res = await fetch(url.toString(), { headers: authHeaders() });
      if (res.ok) {
        const json: HolisticReportResponse = await res.json();
        setHolisticData(json);
        // Expand first zone by default
        if (json.hierarchy.length > 0) {
          setExpandedKeys(new Set([`zone_${json.hierarchy[0].zone}`]));
        }
      }
    } catch (err) {
      console.error('Failed to fetch holistic report:', err);
    } finally {
      setLoadingHolisticData(false);
    }
  }, [isDeveloper]);

  // ── CYCLE REPORT DATA FETCHING ──────────────────────────────────────────
  const fetchCycleData = useCallback(async (
    targetClusterIds: number[],
    targetGateIds: number[],
    start: string,
    end: string
  ) => {
    if (targetGateIds.length === 0) {
      setCycleData(null);
      return;
    }
    setLoadingCycleData(true);
    try {
      const url = new URL(`${API_URL}/api/v1/reports/cycle-analytics`);
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

      const res = await fetch(url.toString(), { headers: authHeaders() });
      if (res.ok) {
        const json: FullCycleAnalyticsResponse = await res.json();
        setCycleData(json);
      }
    } catch (err) {
      console.error('Failed to fetch cycle analytics:', err);
    } finally {
      setLoadingCycleData(false);
    }
  }, [isDeveloper]);

  useEffect(() => {
    if (reportType === 'duration' && selectedGateIds.length > 0) {
      fetchCycleData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr);
    }
  }, [reportType, selectedClusterIds, selectedGateIds, startDateStr, endDateStr, fetchCycleData]);

  // ── TRANSACTIONALLY ORDERED 45-SECOND INCREMENTAL POLLING ───────────────
  const syncIncrementalChanges = useCallback(async () => {
    const params = currentParamsRef.current;
    const activeCursor = currentCursorRef.current;
    if (!params || !activeCursor || !activeCursor.gateRevisions) return;
    if (isPollingRef.current || isRevalidatingRef.current) return;

    isPollingRef.current = true;
    setSyncStatus('updating');

    try {
      let keepDraining = true;
      let drainLoops = 0;
      let currentGateRevisions = { ...activeCursor.gateRevisions };
      const MAX_DRAIN_LOOPS = 20;

      while (keepDraining && drainLoops < MAX_DRAIN_LOOPS) {
        drainLoops++;
        const url = new URL(`${API_URL}/api/v1/reports/records/changes`);

        if (Array.isArray(params.scopeGroupIds) && params.scopeGroupIds.length > 0) {
          url.searchParams.append('scopeGroupIds', params.scopeGroupIds.join(','));
        } else if (params.scopeGroupIds === 'all') {
          url.searchParams.append('scopeGroupIds', 'all');
        }

        if (Array.isArray(params.gateIds) && params.gateIds.length > 0) {
          url.searchParams.append('gateIds', params.gateIds.join(','));
        } else if (params.gateIds === 'all') {
          url.searchParams.append('gateIds', 'all');
        }

        url.searchParams.append('gateRevisions', JSON.stringify(currentGateRevisions));
        url.searchParams.append('startDate', params.startDate);
        url.searchParams.append('endDate', params.endDate);
        if (params.status !== 'ALL') url.searchParams.append('status', params.status);
        if (params.shift !== 'ALL') url.searchParams.append('shift', params.shift);
        if (params.search) url.searchParams.append('search', params.search);

        const res = await fetch(url.toString(), { headers: authHeaders() });
        if (!res.ok) {
          setSyncStatus('outdated');
          break;
        }

        const data = await res.json();

        // 1. Full Synchronization Recovery trigger
        if (data.requiresFullSync) {
          console.info('[ReportsScreen] Server requested full re-sync:', data.resyncReason);
          keepDraining = false;
          if (data.resyncReason === 'GATE_REVOKED') {
            reportsCacheService.clearUserCache(user.id);
            await fetchClusters(true);
          }
          await fetchRecordsData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr, debouncedSearch, {
            forceReload: true,
          });
          break;
        }

        // 2. Process Delta Mutations
        const hasDeltas = (data.events && data.events.length > 0) || (data.deletions && data.deletions.length > 0);
        if (hasDeltas || data.gateRevisions) {
          const updatedEntry = reportsCacheService.updateIncrementalChanges(user.id, params, data);
          if (updatedEntry) {
            setRecords(updatedEntry.records);
            setMetrics(updatedEntry.authoritativeMetrics);
            setCursor(updatedEntry.cursor);
            currentCursorRef.current = updatedEntry.cursor;
            currentGateRevisions = { ...updatedEntry.cursor.gateRevisions };
          }
        }

        // Check if more batches are queued on the server
        keepDraining = data.hasMoreEvents === true;
      }

      if (keepDraining) {
        // Backlog exceeds max drain loops; refresh with full atomic snapshot to ensure nothing is missed
        console.info('[ReportsScreen] Excessive pending change batches, triggering full snapshot re-sync');
        await fetchRecordsData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr, debouncedSearch, {
          forceReload: true,
        });
        return;
      }

      setSyncStatus('synced');
    } catch (err) {
      console.warn('[ReportsScreen] Incremental polling network error:', err);
      setSyncStatus('outdated');
    } finally {
      isPollingRef.current = false;
    }
  }, [
    fetchRecordsData,
    selectedClusterIds,
    selectedGateIds,
    startDateStr,
    endDateStr,
    debouncedSearch,
    user.id
  ]);

  // Polling Lifecycle Controller (45s Interval + Visibility Change Handling)
  useEffect(() => {
    const todayStr = new Date().toISOString().split('T')[0];

    const shouldPoll = () => {
      if (document.hidden) return false;
      // Condition 1: Date range includes today (ongoing operational day)
      const includesToday = endDateStr >= todayStr && startDateStr <= todayStr;
      
      // Condition 2: Historical window has unclosed/OPEN barrier events,
      // even if the active status filter is currently 'CLOSED' or hiding them
      const hasOpenEvent =
        currentCursorRef.current?.hasUnclosedEvents === true ||
        (metrics ? metrics.currentlyOpenCount > 0 : false) ||
        activeRecordsRef.current.some((r) => r.status === 'OPEN');

      return includesToday || hasOpenEvent;
    };

    // 45-Second Scheduled Timer
    const pollInterval = setInterval(() => {
      if (shouldPoll()) {
        syncIncrementalChanges();
      }
    }, 45000);

    // Visibility Listener: Immediate catch-up sync when returning to active tab
    const handleVisibilityChange = () => {
      if (!document.hidden && shouldPoll()) {
        syncIncrementalChanges();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [startDateStr, endDateStr, metrics, syncIncrementalChanges]);

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
    setSelectedExportColumns(['lcNumber', 'locationName', 'openedDate', 'openedTime', 'closedTime', 'durationFormatted', 'status']);
  };

  // Direct Download Trigger (Server-Side Excel or PDF on Full Filtered Dataset)
  const handleDownloadReport = async (format: 'xlsx' | 'pdf' | 'csv') => {

    setIsExporting(true);
    setExportFormat(format.toUpperCase());
    setExportProgress(15);
    setExportStage(reportType === 'duration'
      ? 'Calculating analytical gate cycles & duration metrics from database...'
      : 'Querying operational records from database...');

    const progressTimer = setInterval(() => {
      setExportProgress((prev) => {
        if (prev < 40) {
          setExportStage(reportType === 'duration'
            ? 'Aggregating daily cycle counts and opening/closing intervals...'
            : 'Calculating KPI metrics and column layouts...');
          return prev + 12;
        }
        if (prev < 75) {
          setExportStage(format === 'pdf'
            ? (reportType === 'duration' ? 'Compiling Cycle Summary PDF document...' : 'Compiling PDF document layout & styles...')
            : (reportType === 'duration' ? 'Building Cycle Analytics Excel workbook...' : 'Building Excel spreadsheet workbook...'));
          return prev + 8;
        }
        if (prev < 92) {
          setExportStage('Finalizing binary file download...');
          return prev + 3;
        }
        return prev;
      });
    }, 300);

    try {
      const url = new URL(`${API_URL}/api/v1/reports/export`);
      if (selectedClusterIds.length > 0) {
        url.searchParams.append('scopeGroupIds', selectedClusterIds.join(','));
      } else if (isDeveloper) {
        url.searchParams.append('scopeGroupIds', 'all');
      }

      if (selectedGateIds.length > 0) {
        url.searchParams.append('gateIds', selectedGateIds.join(','));
      } else {
        url.searchParams.append('gateIds', 'all');
      }

      url.searchParams.append('startDate', startDateStr);
      url.searchParams.append('endDate', endDateStr);
      url.searchParams.append('format', format);
      url.searchParams.append('reportType', reportType);
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
      const downloadFilename = reportType === 'count'
        ? `LC_Gate_Count_Report_${startDateStr}_to_${endDateStr}.${format}`
        : reportType === 'holistic'
        ? `LC_Gate_Holistic_Management_Report_${startDateStr}_to_${endDateStr}.${format}`
        : reportType === 'duration'
        ? `LC_Gate_Duration_Report_${startDateStr}_to_${endDateStr}.${format}`
        : `LC_Gate_Complete_Log_${startDateStr}_to_${endDateStr}.${format}`;

      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = downloadFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(downloadUrl);

      clearInterval(progressTimer);
      setExportProgress(100);
      setExportStage('Download complete!');
      setTimeout(() => {
        setIsExporting(false);
      }, 500);

      toastSuccess(`Report downloaded successfully as .${format}!`, 'Export Completed');
    } catch (err: any) {
      clearInterval(progressTimer);
      console.error('Download error:', err);
      toastError(err.message || 'Failed to download report', 'Export Error');
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
            
            {/* 0. Report Type Selection: Complete Log Report vs Cycle Report */}
            <div className="report-type-selector-card">
              <label className="report-type-label">Report Type</label>
              <div className="report-type-btn-group">
                <button
                  type="button"
                  className={`report-type-tab-btn ${reportType === 'complete_log' ? 'active' : ''}`}
                  onClick={() => setReportType('complete_log')}
                  title="Detailed operational history partitioned date-wise"
                >
                  <FaListAlt /> Complete Log
                </button>
                <button
                  type="button"
                  className={`report-type-tab-btn ${reportType === 'duration' ? 'active' : ''}`}
                  onClick={() => setReportType('duration')}
                  title="Analytical operational cycles, daily counts & opening/closing intervals"
                >
                  <FaRetweet /> Cycle Report
                </button>
              </div>
            </div>

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

            {/* Controls for Complete Log Report only */}
            {reportType === 'complete_log' ? (
              <>
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

                {/* 5. Keyword Search */}
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

                {/* 6. Unified Sort Selector */}
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

                {/* 7. Columns Customizer Popover Trigger */}
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
              </>
            ) : (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem', fontSize: '0.75rem', color: '#475569', marginTop: '0.5rem' }}>
                <strong style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#003580', marginBottom: '0.25rem' }}>
                  <FaChartLine /> Cycle Analytical Parameters
                </strong>
                Calculates complete operational cycles (OPEN → CLOSED → OPEN), mean closure durations, and road clearance intervals over 24-hour daily windows.
              </div>
            )}

          </div>

          {/* SIDEBAR FOOTER: DIRECT 1-CLICK EXPORTS */}
          <div className="sidebar-action-footer">
            <div className="export-label-row">
              <span className="export-tag-title">
                {reportType === 'count' ? 'Export Count Report' : reportType === 'duration' ? 'Export Duration Report' : reportType === 'holistic' ? 'Export Holistic Report' : 'Export Event Log'}
              </span>
            </div>
            <div className="export-buttons-pair" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
              <button
                type="button"
                className="btn btn-success btn-sm export-action-btn"
                onClick={() => handleDownloadReport('xlsx')}
                disabled={isExporting || (reportType === 'complete_log' && selectedExportColumns.length === 0)}
                title="Download Excel (.xlsx)"
              >
                <FaFileExcel />
                <span>{isExporting ? '...' : 'Excel'}</span>
              </button>

              <button
                type="button"
                className="btn btn-danger btn-sm export-action-btn"
                onClick={() => handleDownloadReport('pdf')}
                disabled={isExporting || (reportType === 'complete_log' && selectedExportColumns.length === 0)}
                title="Download PDF (.pdf)"
              >
                <FaFilePdf />
                <span>{isExporting ? '...' : 'PDF'}</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm export-action-btn"
                onClick={() => handleDownloadReport('csv')}
                disabled={isExporting || (reportType === 'complete_log' && selectedExportColumns.length === 0)}
                title="Download CSV (.csv)"
              >
                <FaFileCsv />
                <span>{isExporting ? '...' : 'CSV'}</span>
              </button>
            </div>
          </div>
        </aside>

        
        {/* ═══════════════════════════════════════════════════════════
            RIGHT COLUMN: MAIN WORKSPACE (Count, Duration, Holistic, Event Log)
           ═══════════════════════════════════════════════════════════ */}
        {reportType === 'count' ? (
          /* ═══════════════════════════════════════════════════════════════
             1. COUNT REPORT VIEW
             ═══════════════════════════════════════════════════════════════ */
          <main className="view-log-main-card">
            <div className="view-log-header">
              <div>
                <div className="log-title-row">
                  <FaCalculator className="text-primary mr-2" />
                  <h3 className="log-title">Count Report: Gate Operations Volume Audit</h3>
                  {loadingCountData ? (
                    <span className="live-status-pill updating">
                      <FaSyncAlt className="spin mr-1" /> Calculating counts...
                    </span>
                  ) : (
                    <span className="live-status-pill synced">
                      <span className="pulse-dot" /> Live Aggregated
                    </span>
                  )}
                </div>
                <span className="log-subtitle">
                  Aggregated barrier operations (openings, closures, and total volume) from <strong>{startDateStr}</strong> to <strong>{endDateStr}</strong>
                </span>
              </div>

              <div className="view-log-header-right">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fetchCountData(selectedGateIds, startDateStr, endDateStr)}
                  disabled={loadingCountData}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', borderRadius: '8px' }}
                >
                  <FaSyncAlt className={loadingCountData ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* KPI Cards Grid */}
            <div className="cycle-kpi-grid">
              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Operations</span>
                  <FaCalculator className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {countData?.kpis.totalOperations.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">Total barrier movements</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Openings</span>
                  <FaHourglassHalf className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: '#0284c7' }}>
                  {countData?.kpis.totalOpenCount.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">Road clearance events</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Closures</span>
                  <FaRoad className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: '#10b981' }}>
                  {countData?.kpis.totalCloseCount.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">Rail safety closures</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Busiest Level Crossing</span>
                  <FaArchway className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ fontSize: '1.25rem' }}>
                  {countData?.kpis.peakOperationGate ? countData.kpis.peakOperationGate.lcNumber : '—'}
                </div>
                <span className="cycle-kpi-sub">
                  {countData?.kpis.peakOperationGate ? `${countData.kpis.peakOperationGate.operations} operations (${countData.kpis.peakOperationGate.locationName})` : 'No data'}
                </span>
              </div>
            </div>

            {/* Sub-View Switcher Pills */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.6rem' }}>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${countSubView === 'by_gate' ? 'active' : ''}`}
                onClick={() => setCountSubView('by_gate')}
              >
                Level Crossing View ({countData?.gates.length || 0} Gates)
              </button>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${countSubView === 'by_station' ? 'active' : ''}`}
                onClick={() => setCountSubView('by_station')}
              >
                Station Summary ({countData?.stations.length || 0} Stations)
              </button>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${countSubView === 'by_division' ? 'active' : ''}`}
                onClick={() => setCountSubView('by_division')}
              >
                Division Summary ({countData?.divisions.length || 0} Divisions)
              </button>
            </div>

            {/* Table Area */}
            <div className="table-responsive">
              <table className="reports-table">
                <thead>
                  {countSubView === 'by_gate' ? (
                    <tr>
                      <th>Zone</th>
                      <th>Division</th>
                      <th>Station</th>
                      <th>LC Gate #</th>
                      <th>Location</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Operations</th>
                    </tr>
                  ) : countSubView === 'by_station' ? (
                    <tr>
                      <th>Zone</th>
                      <th>Division</th>
                      <th>Station Name</th>
                      <th>Station Code</th>
                      <th style={{ textAlign: 'center' }}>Gates Count</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Operations</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Zone</th>
                      <th>Division</th>
                      <th style={{ textAlign: 'center' }}>Stations Count</th>
                      <th style={{ textAlign: 'center' }}>Gates Count</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Operations</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {loadingCountData ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                        <FaSyncAlt className="spin mr-2" /> Aggregating counts from database...
                      </td>
                    </tr>
                  ) : countSubView === 'by_gate' ? (
                    (countData?.gates || []).map(g => (
                      <tr key={g.gateId}>
                        <td>{g.zone}</td>
                        <td>{g.division}</td>
                        <td>{g.stationName} ({g.stationCode})</td>
                        <td><strong>{g.lcNumber}</strong></td>
                        <td>{g.locationName}</td>
                        <td style={{ textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>{g.openCount}</td>
                        <td style={{ textAlign: 'right', color: '#047857', fontWeight: 600 }}>{g.closeCount}</td>
                        <td style={{ textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>{g.totalOperations}</td>
                      </tr>
                    ))
                  ) : countSubView === 'by_station' ? (
                    (countData?.stations || []).map((s, idx) => (
                      <tr key={idx}>
                        <td>{s.zone}</td>
                        <td>{s.division}</td>
                        <td><strong>{s.stationName}</strong></td>
                        <td><span className="badge badge-secondary">{s.stationCode}</span></td>
                        <td style={{ textAlign: 'center' }}>{s.gatesCount}</td>
                        <td style={{ textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>{s.openCount}</td>
                        <td style={{ textAlign: 'right', color: '#047857', fontWeight: 600 }}>{s.closeCount}</td>
                        <td style={{ textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>{s.totalOperations}</td>
                      </tr>
                    ))
                  ) : (
                    (countData?.divisions || []).map((d, idx) => (
                      <tr key={idx}>
                        <td>{d.zone}</td>
                        <td><strong>{d.division}</strong></td>
                        <td style={{ textAlign: 'center' }}>{d.stationCount}</td>
                        <td style={{ textAlign: 'center' }}>{d.gatesCount}</td>
                        <td style={{ textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>{d.openCount}</td>
                        <td style={{ textAlign: 'right', color: '#047857', fontWeight: 600 }}>{d.closeCount}</td>
                        <td style={{ textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>{d.totalOperations}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </main>
        ) : reportType === 'duration' ? (
          /* ═══════════════════════════════════════════════════════════════
             2. DURATION REPORT VIEW
             ═══════════════════════════════════════════════════════════════ */
          <main className="view-log-main-card">
            <div className="view-log-header">
              <div>
                <div className="log-title-row">
                  <FaClock className="text-primary mr-2" />
                  <h3 className="log-title">Duration Report: Gate Open vs Closed Timing Analysis</h3>
                  {loadingCycleData ? (
                    <span className="live-status-pill updating">
                      <FaSyncAlt className="spin mr-1" /> Calculating durations...
                    </span>
                  ) : (
                    <span className="live-status-pill synced">
                      <span className="pulse-dot" /> Live Synced
                    </span>
                  )}
                </div>
                <span className="log-subtitle">
                  Road clearance durations, train closure blocks, and daily time breakdown from <strong>{startDateStr}</strong> to <strong>{endDateStr}</strong>
                </span>
              </div>

              <div className="view-log-header-right">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fetchCycleData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr)}
                  disabled={loadingCycleData}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', borderRadius: '8px' }}
                >
                  <FaSyncAlt className={loadingCycleData ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* Duration KPI Cards Grid */}
            <div className="cycle-kpi-grid">
              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Completed Cycles</span>
                  <FaRetweet className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalCycles.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">Total measured operations</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Avg Opening Duration</span>
                  <FaClock className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: '#0369a1' }}>
                  {cycleData?.overall.avgOpeningFormatted || '—'}
                </div>
                <span className="cycle-kpi-sub">Mean road clearance time</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Avg Closing Time</span>
                  <FaHourglassHalf className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: '#10b981' }}>
                  {cycleData?.overall.avgClosingFormatted || '—'}
                </div>
                <span className="cycle-kpi-sub">Mean train safety closure</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Open Duration</span>
                  <FaChartLine className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalOpenFormatted || '0s'}
                </div>
                <span className="cycle-kpi-sub">Cumulative road clearance</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Closed Duration</span>
                  <FaRoad className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalClosedFormatted || '0s'}
                </div>
                <span className="cycle-kpi-sub">Cumulative rail restriction</span>
              </div>
            </div>

            {/* Multi-Gate Filter Selector Bar */}
            {cycleData && cycleData.gateReports.length > 1 && (
              <div className="cycle-gate-selector-bar">
                <span className="cycle-gate-selector-label">Filter View:</span>
                <button
                  type="button"
                  className={`cycle-gate-tab-pill ${selectedCycleGateId === 'ALL' ? 'active' : ''}`}
                  onClick={() => setSelectedCycleGateId('ALL')}
                >
                  All {cycleData.gateReports.length} Gates
                </button>
                {cycleData.gateReports.map(gr => (
                  <button
                    key={gr.gate.id}
                    type="button"
                    className={`cycle-gate-tab-pill ${selectedCycleGateId === gr.gate.id ? 'active' : ''}`}
                    onClick={() => setSelectedCycleGateId(gr.gate.id)}
                  >
                    {gr.gate.lcNumber} ({gr.kpis.totalCycles} cycles)
                  </button>
                ))}
              </div>
            )}

            {/* Daily Cycle Summary Table */}
            <div className="table-responsive">
              <table className="reports-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>LC Gate #</th>
                    <th>Location / Station</th>
                    <th style={{ textAlign: 'center' }}>Completed Cycles</th>
                    <th style={{ textAlign: 'right' }}>Avg Opening Duration</th>
                    <th style={{ textAlign: 'right' }}>Avg Closing Duration</th>
                    <th style={{ textAlign: 'right' }}>Total Closed Time</th>
                    <th style={{ textAlign: 'right' }}>Total Open Time</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingCycleData ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                        <FaSyncAlt className="spin mr-2" /> Calculating duration metrics from database...
                      </td>
                    </tr>
                  ) : !cycleData || cycleData.gateReports.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                        No cycle records found for the selected gates and dates.
                      </td>
                    </tr>
                  ) : (
                    cycleData.gateReports
                      .filter(gr => selectedCycleGateId === 'ALL' || gr.gate.id === selectedCycleGateId)
                      .flatMap(gr =>
                        gr.dailyBreakdown.map(day => (
                          <tr key={`${gr.gate.id}-${day.dateStr}`}>
                            <td>{day.dateFormatted}</td>
                            <td><strong>{gr.gate.lcNumber}</strong></td>
                            <td>{gr.gate.locationName}</td>
                            <td style={{ textAlign: 'center' }}>
                              <span className="badge badge-primary">{day.completedCycles}</span>
                            </td>
                            <td style={{ textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>{day.avgOpeningFormatted}</td>
                            <td style={{ textAlign: 'right', color: '#047857', fontWeight: 600 }}>{day.avgClosingFormatted}</td>
                            <td style={{ textAlign: 'right' }}>{day.totalClosedFormatted}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700 }}>{day.totalOpenFormatted}</td>
                          </tr>
                        ))
                      )
                  )}
                </tbody>
              </table>
            </div>
          </main>
        ) : reportType === 'holistic' ? (
          /* ═══════════════════════════════════════════════════════════════
             3. HOLISTIC MANAGEMENT REPORT VIEW
             ═══════════════════════════════════════════════════════════════ */
          <main className="view-log-main-card">
            <div className="view-log-header">
              <div>
                <div className="log-title-row">
                  <FaLayerGroup className="text-primary mr-2" />
                  <h3 className="log-title">Holistic Report: Consolidated Management Hierarchy</h3>
                  {loadingHolisticData ? (
                    <span className="live-status-pill updating">
                      <FaSyncAlt className="spin mr-1" /> Consolidating metrics...
                    </span>
                  ) : (
                    <span className="live-status-pill synced">
                      <span className="pulse-dot" /> Management View
                    </span>
                  )}
                </div>
                <span className="log-subtitle">
                  Unified operations count and duration performance rolled up across Indian Railways hierarchy
                </span>
              </div>

              <div className="view-log-header-right">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fetchHolisticData(selectedGateIds, startDateStr, endDateStr)}
                  disabled={loadingHolisticData}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', borderRadius: '8px' }}
                >
                  <FaSyncAlt className={loadingHolisticData ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* Holistic Executive KPI Summary */}
            <div className="cycle-kpi-grid">
              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Active Hierarchy</span>
                  <FaLayerGroup className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ fontSize: '1.2rem' }}>
                  {holisticData ? `${holisticData.kpis.totalGates} Gates (${holisticData.kpis.totalStations} Stations)` : '—'}
                </div>
                <span className="cycle-kpi-sub">
                  {holisticData ? `Across ${holisticData.kpis.totalDivisions} Divisions & ${holisticData.kpis.totalZones} Zones` : '—'}
                </span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Operations</span>
                  <FaCalculator className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {holisticData?.kpis.totalOperations.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">Open + Close movements</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Open Duration</span>
                  <FaChartLine className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: '#0369a1' }}>
                  {holisticData?.kpis.totalOpenFormatted || '0s'}
                </div>
                <span className="cycle-kpi-sub">Avg per open: {holisticData?.kpis.avgOpenFormatted || '0s'}</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Extended Delays (&gt;10m)</span>
                  <FaHourglassHalf className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value" style={{ color: (holisticData?.kpis.totalExtendedDelays || 0) > 0 ? '#b45309' : '#10b981' }}>
                  {holisticData?.kpis.totalExtendedDelays ?? 0}
                </div>
                <span className="cycle-kpi-sub">Critical road blockages</span>
              </div>
            </div>

            {/* Sub-View Switcher Pills */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.6rem' }}>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${holisticSubView === 'hierarchy' ? 'active' : ''}`}
                onClick={() => setHolisticSubView('hierarchy')}
              >
                Tree Hierarchy (Zone → Div → Station → Gate)
              </button>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${holisticSubView === 'stations' ? 'active' : ''}`}
                onClick={() => setHolisticSubView('stations')}
              >
                Station Performance Ranking ({holisticData?.flatStations.length || 0})
              </button>
              <button
                type="button"
                className={`cycle-gate-tab-pill ${holisticSubView === 'gates' ? 'active' : ''}`}
                onClick={() => setHolisticSubView('gates')}
              >
                Gate-Level Detailed Matrix ({holisticData?.flatGates.length || 0})
              </button>
            </div>

            {/* Table Area */}
            <div className="table-responsive">
              {holisticSubView === 'hierarchy' ? (
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th style={{ width: '38%' }}>Jurisdiction / Entity</th>
                      <th style={{ textAlign: 'center' }}>Gates</th>
                      <th style={{ textAlign: 'right' }}>Operations</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Open Time</th>
                      <th style={{ textAlign: 'right' }}>Avg Open</th>
                      <th style={{ textAlign: 'center' }}>Delays (&gt;10m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingHolisticData ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                          <FaSyncAlt className="spin mr-2" /> Consolidating management hierarchy...
                        </td>
                      </tr>
                    ) : (
                      (holisticData?.hierarchy || []).map(zn => {
                        const zKey = `zone_${zn.zone}`;
                        const isZoneOpen = expandedKeys.has(zKey);
                        return (
                          <React.Fragment key={zKey}>
                            {/* ZONE ROW */}
                            <tr
                              onClick={() => {
                                const next = new Set(expandedKeys);
                                if (isZoneOpen) next.delete(zKey); else next.add(zKey);
                                setExpandedKeys(next);
                              }}
                              style={{ background: '#e0f2fe', cursor: 'pointer', fontWeight: 800 }}
                            >
                              <td>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#0369a1' }}>
                                  {isZoneOpen ? <FaChevronDown size={10} /> : <FaChevronUp size={10} style={{ transform: 'rotate(90deg)' }} />}
                                  <FaLayerGroup size={12} />
                                  <span>ZONE: {zn.zone}</span>
                                </span>
                              </td>
                              <td style={{ textAlign: 'center' }}>{zn.gatesCount}</td>
                              <td style={{ textAlign: 'right' }}>{zn.totalOperations}</td>
                              <td style={{ textAlign: 'right', color: '#0369a1' }}>{zn.openCount}</td>
                              <td style={{ textAlign: 'right', color: '#047857' }}>{zn.closeCount}</td>
                              <td style={{ textAlign: 'right' }}>{zn.totalOpenFormatted}</td>
                              <td style={{ textAlign: 'right' }}>{zn.avgOpenFormatted}</td>
                              <td style={{ textAlign: 'center' }}>
                                <span className={`badge ${zn.extendedDelaysCount > 0 ? 'badge-warning' : 'badge-success'}`}>
                                  {zn.extendedDelaysCount}
                                </span>
                              </td>
                            </tr>

                            {/* DIVISIONS */}
                            {isZoneOpen && zn.divisions.map(div => {
                              const dKey = `div_${zn.zone}_${div.division}`;
                              const isDivOpen = expandedKeys.has(dKey);
                              return (
                                <React.Fragment key={dKey}>
                                  <tr
                                    onClick={() => {
                                      const next = new Set(expandedKeys);
                                      if (isDivOpen) next.delete(dKey); else next.add(dKey);
                                      setExpandedKeys(next);
                                    }}
                                    style={{ background: '#f1f5f9', cursor: 'pointer', fontWeight: 700 }}
                                  >
                                    <td style={{ paddingLeft: '2rem' }}>
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#334155' }}>
                                        {isDivOpen ? <FaChevronDown size={9} /> : <FaChevronUp size={9} style={{ transform: 'rotate(90deg)' }} />}
                                        <span>DIVISION: {div.division}</span>
                                      </span>
                                    </td>
                                    <td style={{ textAlign: 'center' }}>{div.gatesCount}</td>
                                    <td style={{ textAlign: 'right' }}>{div.totalOperations}</td>
                                    <td style={{ textAlign: 'right', color: '#0369a1' }}>{div.openCount}</td>
                                    <td style={{ textAlign: 'right', color: '#047857' }}>{div.closeCount}</td>
                                    <td style={{ textAlign: 'right' }}>{div.totalOpenFormatted}</td>
                                    <td style={{ textAlign: 'right' }}>{div.avgOpenFormatted}</td>
                                    <td style={{ textAlign: 'center' }}>
                                      <span className={`badge ${div.extendedDelaysCount > 0 ? 'badge-warning' : 'badge-success'}`}>
                                        {div.extendedDelaysCount}
                                      </span>
                                    </td>
                                  </tr>

                                  {/* STATIONS */}
                                  {isDivOpen && div.stations.map(st => {
                                    const sKey = `st_${st.stationName}`;
                                    const isStOpen = expandedKeys.has(sKey);
                                    return (
                                      <React.Fragment key={sKey}>
                                        <tr
                                          onClick={() => {
                                            const next = new Set(expandedKeys);
                                            if (isStOpen) next.delete(sKey); else next.add(sKey);
                                            setExpandedKeys(next);
                                          }}
                                          style={{ background: '#ffffff', cursor: 'pointer' }}
                                        >
                                          <td style={{ paddingLeft: '3.5rem' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#0f172a' }}>
                                              {isStOpen ? <FaChevronDown size={8} /> : <FaChevronUp size={8} style={{ transform: 'rotate(90deg)' }} />}
                                              <strong>{st.stationName} ({st.stationCode})</strong>
                                            </span>
                                          </td>
                                          <td style={{ textAlign: 'center' }}>{st.gatesCount}</td>
                                          <td style={{ textAlign: 'right', fontWeight: 700 }}>{st.totalOperations}</td>
                                          <td style={{ textAlign: 'right', color: '#0369a1' }}>{st.openCount}</td>
                                          <td style={{ textAlign: 'right', color: '#047857' }}>{st.closeCount}</td>
                                          <td style={{ textAlign: 'right' }}>{st.totalOpenFormatted}</td>
                                          <td style={{ textAlign: 'right' }}>{st.avgOpenFormatted}</td>
                                          <td style={{ textAlign: 'center' }}>{st.extendedDelaysCount}</td>
                                        </tr>

                                        {/* GATES UNDER STATION */}
                                        {isStOpen && st.gates.map(g => (
                                          <tr key={g.gateId} style={{ background: '#fafafa', fontSize: '0.82rem' }}>
                                            <td style={{ paddingLeft: '5rem', color: '#64748b' }}>
                                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                <FaArchway size={10} color="#0B3C7A" />
                                                <strong style={{ color: '#0f172a' }}>{g.lcNumber}</strong> — {g.locationName}
                                              </span>
                                            </td>
                                            <td style={{ textAlign: 'center', color: '#94a3b8' }}>1</td>
                                            <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.totalOperations}</td>
                                            <td style={{ textAlign: 'right', color: '#0369a1' }}>{g.openCount}</td>
                                            <td style={{ textAlign: 'right', color: '#047857' }}>{g.closeCount}</td>
                                            <td style={{ textAlign: 'right' }}>{g.totalOpenFormatted}</td>
                                            <td style={{ textAlign: 'right' }}>{g.avgOpenFormatted}</td>
                                            <td style={{ textAlign: 'center' }}>{g.extendedDelaysCount}</td>
                                          </tr>
                                        ))}
                                      </React.Fragment>
                                    );
                                  })}
                                </React.Fragment>
                              );
                            })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              ) : holisticSubView === 'stations' ? (
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Division</th>
                      <th>Station Name</th>
                      <th>Code</th>
                      <th style={{ textAlign: 'center' }}>Gates Count</th>
                      <th style={{ textAlign: 'right' }}>Operations</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Open Time</th>
                      <th style={{ textAlign: 'right' }}>Avg Open</th>
                      <th style={{ textAlign: 'center' }}>Delays (&gt;10m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(holisticData?.flatStations || []).map((st, idx) => (
                      <tr key={idx}>
                        <td>{st.zone}</td>
                        <td>{st.division}</td>
                        <td><strong>{st.stationName}</strong></td>
                        <td><span className="badge badge-secondary">{st.stationCode}</span></td>
                        <td style={{ textAlign: 'center' }}>{st.gatesCount}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{st.totalOperations}</td>
                        <td style={{ textAlign: 'right', color: '#0369a1' }}>{st.openCount}</td>
                        <td style={{ textAlign: 'right', color: '#047857' }}>{st.closeCount}</td>
                        <td style={{ textAlign: 'right' }}>{st.totalOpenFormatted}</td>
                        <td style={{ textAlign: 'right' }}>{st.avgOpenFormatted}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`badge ${st.extendedDelaysCount > 0 ? 'badge-warning' : 'badge-success'}`}>
                            {st.extendedDelaysCount}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Division</th>
                      <th>Station</th>
                      <th>LC Gate #</th>
                      <th>Location</th>
                      <th style={{ textAlign: 'right' }}>Operations</th>
                      <th style={{ textAlign: 'right' }}>Open Count</th>
                      <th style={{ textAlign: 'right' }}>Close Count</th>
                      <th style={{ textAlign: 'right' }}>Total Open Time</th>
                      <th style={{ textAlign: 'right' }}>Avg Open</th>
                      <th style={{ textAlign: 'center' }}>Delays (&gt;10m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(holisticData?.flatGates || []).map(g => (
                      <tr key={g.gateId}>
                        <td>{g.zone}</td>
                        <td>{g.division}</td>
                        <td>{g.stationName} ({g.stationCode})</td>
                        <td><strong>{g.lcNumber}</strong></td>
                        <td>{g.locationName}</td>
                        <td style={{ textAlign: 'right', fontWeight: 800 }}>{g.totalOperations}</td>
                        <td style={{ textAlign: 'right', color: '#0369a1' }}>{g.openCount}</td>
                        <td style={{ textAlign: 'right', color: '#047857' }}>{g.closeCount}</td>
                        <td style={{ textAlign: 'right' }}>{g.totalOpenFormatted}</td>
                        <td style={{ textAlign: 'right' }}>{g.avgOpenFormatted}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`badge ${g.extendedDelaysCount > 0 ? 'badge-warning' : 'badge-success'}`}>
                            {g.extendedDelaysCount}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </main>
        ) : (
          /* ═══════════════════════════════════════════════════════════════
             4. DETAILED OPERATIONAL EVENT LOG (COMPLETE LOG)
             ═══════════════════════════════════════════════════════════════ */

          <main className="view-log-main-card">
            <div className="view-log-header">
            <div>
              <div className="log-title-row">
                <FaArchway className="text-primary mr-2" />
                <h3 className="log-title">View Log: Operational Records</h3>
                {loadingRecords && records.length === 0 ? (
                  <span className="live-status-pill updating">
                    <FaSyncAlt className="spin mr-1" /> Loading...
                  </span>
                ) : syncStatus === 'updating' ? (
                  <span className="live-status-pill updating">
                    <FaSyncAlt className="spin mr-1" /> Updating...
                  </span>
                ) : syncStatus === 'outdated' ? (
                  <span className="live-status-pill outdated" title="Background refresh failed. Displaying cached data.">
                    <span className="live-dot" style={{ backgroundColor: '#d97706' }} /> Cached (Offline)
                  </span>
                ) : (
                  <span className="live-status-pill synced">
                    <span className="pulse-dot" /> Live Synced
                  </span>
                )}
              </div>
              <span className="log-subtitle">
                Displaying <strong>{records.length}</strong> events for selected criteria ({startDateStr} to {endDateStr})
                {metrics && metrics.currentlyOpenCount > 0 && (
                  <span className="ml-2 text-danger font-semibold">
                    • {metrics.currentlyOpenCount} gate{metrics.currentlyOpenCount === 1 ? '' : 's'} currently open
                  </span>
                )}
              </span>
            </div>

            <div className="view-log-header-right" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
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
                className="btn btn-secondary btn-sm"
                onClick={() => fetchRecordsData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr, debouncedSearch, { forceReload: true })}
                disabled={loadingRecords || syncStatus === 'updating'}
                title="Force refresh data from database"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', borderRadius: '8px' }}
              >
                <FaSyncAlt className={syncStatus === 'updating' ? 'spin' : ''} />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {/* Real-time Table */}
          <div className="table-responsive">
            <table className="reports-table">
              <thead>
                <tr>
                  {selectedExportColumns.includes('scopeGroup') && <th>Cluster</th>}
                  {selectedExportColumns.includes('lcNumber') && <th>LC Number</th>}
                  {selectedExportColumns.includes('masterUnit') && <th>Master Unit</th>}
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
                {loadingRecords && records.length === 0 ? (
                  <tr>
                    <td colSpan={selectedExportColumns.length || 1} className="text-center py-5">
                      <FaSyncAlt className="spin mr-2" /> Loading operational logs from database...
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
                        {selectedExportColumns.includes('masterUnit') && (
                          <td>
                            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#334155', background: '#f1f5f9', padding: '2px 7px', borderRadius: 4 }}>
                              {rec.masterSerial || rec.thingName || '-'}
                            </span>
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
        )}
      </div>

      {/* ── REPORT GENERATION PROGRESS BAR MODAL ── */}
      {isExporting && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)', backdropFilter: 'blur(4px)' }}
        >
          <div 
            className="glass-panel p-6 rounded-2xl shadow-2xl max-w-md w-full text-center"
            style={{ backgroundColor: '#ffffff', color: '#0f172a' }}
          >
            <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center bg-blue-50 text-blue-700 text-2xl">
              <FaSyncAlt className="spin" />
            </div>
            <h3 className="text-lg font-bold m-0 mb-1" style={{ color: '#0B3C7A' }}>
              Generating {exportFormat} Report
            </h3>
            <p className="text-xs text-gray-500 m-0 mb-4">
              Please wait while the platform compiles your operational logs & metrics.
            </p>

            {/* Progress Bar Container */}
            <div className="w-full bg-gray-100 rounded-full h-3 mb-2 overflow-hidden border border-gray-200">
              <div 
                className="h-full rounded-full transition-all duration-300 ease-out"
                style={{ 
                  width: `${exportProgress}%`, 
                  background: 'linear-gradient(90deg, #0284c7 0%, #0B3C7A 100%)' 
                }}
              />
            </div>

            <div className="flex justify-between items-center text-xs font-semibold text-gray-600 mb-1">
              <span>{exportStage}</span>
              <span className="text-blue-700 font-bold">{exportProgress}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
