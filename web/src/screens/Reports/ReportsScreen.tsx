import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  FaChartLine
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

  // 5. Operational Records & Caching State
  const [reportType, setReportType] = useState<'complete_log' | 'cycle'>('complete_log');
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
    if (reportType === 'cycle' && selectedGateIds.length > 0) {
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
    setSelectedExportColumns(['scopeGroup', 'lcNumber', 'locationName', 'openedDate', 'openedTime', 'closedTime', 'durationFormatted', 'status']);
  };

  // Direct Download Trigger (Server-Side Excel or PDF on Full Filtered Dataset)
  const handleDownloadReport = async (format: 'xlsx' | 'pdf') => {
    if (selectedGateIds.length === 0) {
      toastInfo('Please select at least one gate to generate the report');
      return;
    }

    setIsExporting(true);
    setExportFormat(format.toUpperCase());
    setExportProgress(15);
    setExportStage(reportType === 'cycle'
      ? 'Calculating analytical gate cycles & duration metrics from database...'
      : 'Querying operational records from database...');

    const progressTimer = setInterval(() => {
      setExportProgress((prev) => {
        if (prev < 40) {
          setExportStage(reportType === 'cycle'
            ? 'Aggregating daily cycle counts and opening/closing intervals...'
            : 'Calculating KPI metrics and column layouts...');
          return prev + 12;
        }
        if (prev < 75) {
          setExportStage(format === 'pdf'
            ? (reportType === 'cycle' ? 'Compiling Cycle Summary PDF document...' : 'Compiling PDF document layout & styles...')
            : (reportType === 'cycle' ? 'Building Cycle Analytics Excel workbook...' : 'Building Excel spreadsheet workbook...'));
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
      } else if (isDeveloper) {
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
      const downloadFilename = reportType === 'cycle'
        ? `LC_Gate_Cycle_Report_${startDateStr}_to_${endDateStr}.${format}`
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
                  className={`report-type-tab-btn ${reportType === 'cycle' ? 'active' : ''}`}
                  onClick={() => setReportType('cycle')}
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
                {reportType === 'cycle' ? 'Export Cycle Report' : 'Export Complete Log'}
              </span>
            </div>
            <div className="export-buttons-pair">
              <button
                type="button"
                className="btn btn-success btn-sm export-action-btn"
                onClick={() => handleDownloadReport('xlsx')}
                disabled={isExporting || (reportType === 'complete_log' && selectedExportColumns.length === 0)}
                title={reportType === 'cycle' ? 'Download analytical Cycle Report (.xlsx)' : 'Download operational Complete Log (.xlsx)'}
              >
                <FaFileExcel />
                <span>{isExporting ? 'Exporting...' : 'Excel (.xlsx)'}</span>
              </button>

              <button
                type="button"
                className="btn btn-danger btn-sm export-action-btn"
                onClick={() => handleDownloadReport('pdf')}
                disabled={isExporting || (reportType === 'complete_log' && selectedExportColumns.length === 0)}
                title={reportType === 'cycle' ? 'Download analytical Cycle Report (.pdf)' : 'Download operational Complete Log (.pdf)'}
              >
                <FaFilePdf />
                <span>{isExporting ? 'Exporting...' : 'PDF (.pdf)'}</span>
              </button>
            </div>
          </div>
        </aside>

        {/* ═══════════════════════════════════════════════════════════
            RIGHT COLUMN: MAIN WORKSPACE (Real-Time Reactive)
           ═══════════════════════════════════════════════════════════ */}
        {reportType === 'cycle' ? (
          <main className="view-log-main-card">
            {/* Header */}
            <div className="view-log-header">
              <div>
                <div className="log-title-row">
                  <FaRetweet className="text-primary mr-2" />
                  <h3 className="log-title">Cycle Report: Analytical Summary & Gate Utilization</h3>
                  {loadingCycleData ? (
                    <span className="live-status-pill updating">
                      <FaSyncAlt className="spin mr-1" /> Calculating cycles...
                    </span>
                  ) : (
                    <span className="live-status-pill synced">
                      <span className="pulse-dot" /> Live Synced
                    </span>
                  )}
                </div>
                <span className="log-subtitle">
                  Analytical operational cycles, closing durations, and opening intervals from <strong>{startDateStr}</strong> to <strong>{endDateStr}</strong>
                </span>
              </div>

              <div className="view-log-header-right">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => fetchCycleData(selectedClusterIds, selectedGateIds, startDateStr, endDateStr)}
                  disabled={loadingCycleData}
                  title="Recalculate cycle metrics from database"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.75rem', borderRadius: '8px' }}
                >
                  <FaSyncAlt className={loadingCycleData ? 'spin' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            {/* KPI Cards Grid */}
            <div className="cycle-kpi-grid">
              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Completed Cycles</span>
                  <FaRetweet className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalCycles.toLocaleString('en-IN') ?? '0'}
                </div>
                <span className="cycle-kpi-sub">OPEN → CLOSED → OPEN operations</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Avg Closing Time</span>
                  <FaHourglassHalf className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.avgClosingFormatted || '—'}
                </div>
                <span className="cycle-kpi-sub">Mean closure duration per cycle</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Avg Opening Interval</span>
                  <FaClock className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.avgOpeningFormatted || '—'}
                </div>
                <span className="cycle-kpi-sub">Road clearance interval between closures</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Closed Duration</span>
                  <FaRoad className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalClosedFormatted || '0s'}
                </div>
                <span className="cycle-kpi-sub">Cumulative road restriction</span>
              </div>

              <div className="cycle-kpi-card">
                <div className="cycle-kpi-header">
                  <span className="cycle-kpi-title">Total Open Duration</span>
                  <FaChartLine className="cycle-kpi-icon" />
                </div>
                <div className="cycle-kpi-value">
                  {cycleData?.overall.totalOpenFormatted || '0s'}
                </div>
                <span className="cycle-kpi-sub">Cumulative road clearance time</span>
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
                    <th>Gate</th>
                    <th>Operational Date</th>
                    <th className="text-center">Completed Cycles</th>
                    <th className="text-center">Avg Closing Time</th>
                    <th className="text-center">Avg Opening Time</th>
                    <th className="text-center">Total Closed</th>
                    <th className="text-center">Total Open</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingCycleData && !cycleData ? (
                    <tr>
                      <td colSpan={7} className="text-center py-5">
                        <FaSyncAlt className="spin mr-2" /> Calculating operational cycle metrics...
                      </td>
                    </tr>
                  ) : !cycleData || cycleData.gateReports.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-5 empty-cell">
                        <FaArchway size={34} className="mb-2 text-muted" />
                        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.95rem', color: '#334155' }}>
                          No operational cycle records found.
                        </p>
                        <small className="text-muted">
                          Adjust scope groups, gates, or date range in the left builder panel.
                        </small>
                      </td>
                    </tr>
                  ) : (
                    cycleData.gateReports
                      .filter(gr => selectedCycleGateId === 'ALL' || selectedCycleGateId === gr.gate.id)
                      .flatMap(gr =>
                        gr.dailyBreakdown.map((day, idx) => (
                          <tr key={`${gr.gate.id}_${day.dateStr}_${idx}`}>
                            <td>
                              <strong className="lc-tag">{gr.gate.lcNumber}</strong>
                              <span className="text-muted small ml-1">{gr.gate.locationName}</span>
                            </td>
                            <td>{day.dateFormatted}</td>
                            <td className="text-center">
                              {day.completedCycles > 0 ? (
                                <span className="cycle-count-badge">
                                  {day.completedCycles}
                                </span>
                              ) : (
                                <span className="cycle-zero-badge">0</span>
                              )}
                            </td>
                            <td className="text-center text-mono">
                              {day.avgClosingFormatted}
                            </td>
                            <td className="text-center text-mono">
                              {day.avgOpeningFormatted}
                            </td>
                            <td className="text-center text-mono">
                              {day.totalClosedFormatted}
                            </td>
                            <td className="text-center text-mono">
                              {day.totalOpenFormatted}
                            </td>
                          </tr>
                        ))
                      )
                  )}
                </tbody>
              </table>
            </div>
          </main>
        ) : (
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
