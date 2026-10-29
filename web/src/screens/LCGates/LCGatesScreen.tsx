import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  FaArchway,
  FaFolder,
  FaFolderOpen,
  FaFolderPlus,
  FaMicrochip,
  FaMapMarkerAlt,
  FaSun,
  FaBolt,
  FaCamera,
  FaSearch,
  FaArrowLeft,
  FaTimes,
  FaSyncAlt,
  FaChevronRight,
  FaLayerGroup,
  FaCheckCircle,
  FaTrain,
  FaPlug,
  FaInfoCircle,
  FaBroadcastTower,
  FaExternalLinkAlt,
  FaEye,
  FaCode,
  FaShieldAlt
} from 'react-icons/fa';

import type { User, ScopeGroupItem } from '../../types';
import { API_URL } from '../../config';
import DeviceInfoModal from '../../components/DeviceInfoModal';
import './LCGatesScreen.css';
import { useToast } from '../../context/ToastContext';
import {
  FaSlidersH,
  FaHeartbeat,
  FaTable,
  FaCopy,
  FaCheck,
  FaServer,
  FaFileAlt,
  FaHistory,
  FaClock,
  FaDoorOpen,
  FaDoorClosed,
  FaPaperPlane,
  FaExclamationTriangle,
  FaBatteryFull,
  FaSignal
} from 'react-icons/fa';

/**
 * Universal key-value renderer for real device payloads
 */
function renderCleanKeyValueTable(data: any): React.ReactNode {
  if (!data || typeof data !== 'object') {
    return (
      <div className="py-4 text-center text-muted" style={{ fontSize: '0.85rem' }}>
        No payload properties available.
      </div>
    );
  }

  const entries = Object.entries(data);
  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-muted" style={{ fontSize: '0.85rem' }}>
        Payload object is empty.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#ffffff' }}>
      <table className="dynamic-table" style={{ width: '100%', fontSize: '0.86rem' }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={{ width: '32%', fontWeight: 700, color: '#334155' }}>Parameter Key</th>
            <th style={{ fontWeight: 700, color: '#334155' }}>Reported Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, val]) => {
            const isStatus = key.toLowerCase() === 'status';
            const isBool = typeof val === 'boolean';
            const isObject = typeof val === 'object' && val !== null;
            const strVal = String(val);

            return (
              <tr key={key}>
                <td style={{ fontWeight: 600, color: '#1e293b' }}>
                  <code style={{ fontSize: '0.82rem', color: '#0f172a', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>
                    {key}
                  </code>
                </td>
                <td>
                  {isStatus ? (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '3px 12px',
                        borderRadius: '6px',
                        fontWeight: 800,
                        fontSize: '0.82rem',
                        letterSpacing: '0.3px',
                        background: (strVal.toUpperCase() === 'NOT_CLOSED' ? 'OPEN' : strVal).toUpperCase() === 'CLOSED' ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                        color: (strVal.toUpperCase() === 'NOT_CLOSED' ? 'OPEN' : strVal).toUpperCase() === 'CLOSED' ? '#047857' : '#b91c1c',
                        border: `1px solid ${(strVal.toUpperCase() === 'NOT_CLOSED' ? 'OPEN' : strVal).toUpperCase() === 'CLOSED' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
                      }}
                    >
                      {strVal.toUpperCase() === 'NOT_CLOSED' ? 'OPEN' : strVal}
                    </span>
                  ) : isBool ? (
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 10px',
                        borderRadius: '4px',
                        fontWeight: 700,
                        fontSize: '0.78rem',
                        background: val ? 'rgba(16, 185, 129, 0.12)' : 'rgba(100, 116, 139, 0.12)',
                        color: val ? '#059669' : '#475569',
                      }}
                    >
                      {val ? 'TRUE (Closed)' : 'FALSE (Open)'}
                    </span>
                  ) : isObject ? (
                    <pre style={{ margin: 0, fontSize: '0.78rem', background: '#f8fafc', padding: '8px 12px', borderRadius: '4px', border: '1px solid #e2e8f0', overflowX: 'auto', color: '#0f172a' }}>
                      {JSON.stringify(val, null, 2)}
                    </pre>
                  ) : (
                    <span style={{ fontWeight: 600, color: '#0f172a' }}>
                      {strVal}
                      {key.toLowerCase().includes('ms') && !isNaN(Number(val)) ? ' ms' : ''}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Props = {
  user: User;
};

const authHeaders = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
});

const getFullImageUrl = (url?: string) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_URL}${url}`;
};

export default function LCGatesScreen({ user: _user }: Props) {
  // Scope Group Hierarchy Navigation Stack ([] = Scope Groups Landing Page)
  const [scopeGroupStack, setScopeGroupStack] = useState<ScopeGroupItem[]>([]);
  const currentScopeGroup = scopeGroupStack.length > 0 ? scopeGroupStack[scopeGroupStack.length - 1] : null;
  const currentFolderId = currentScopeGroup ? currentScopeGroup.id : null;

  // View Mode: 'folder' (Scope Groups / Clusters Directory) or 'detail' (Cluster Drilldown)
  const [viewMode, setViewMode] = useState<'folder' | 'detail'>('folder');

  // Selected Cluster for Full Drilldown
  const [selectedGate, setSelectedGate] = useState<any | null>(null);

  // Drilldown Active Tab: 'about_manifest' | 'telemetry'
  const [clusterTab, setClusterTab] = useState<'about_manifest' | 'telemetry'>('about_manifest');
  const [deviceInfoItem, setDeviceInfoItem] = useState<any | null>(null);

  const { success: toastSuccess, error: toastError } = useToast();

  // Telemetry Inspector state for the selected gate
  const [gateTelemetry, setGateTelemetry] = useState<any | null>(null);
  const [loadingTelemetry, setLoadingTelemetry] = useState<boolean>(false);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [selectedPayloadId, setSelectedPayloadId] = useState<number | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const [inspectSubTab, setInspectSubTab] = useState<'telemetry' | 'manifest' | 'health' | 'all' | 'cycles'>('telemetry');
  const [healthCheckStage, setHealthCheckStage] = useState<'IDLE' | 'DISPATCHING' | 'LISTENING' | 'SUCCESS' | 'TIMEOUT'>('IDLE');
  const [telemetryViewMode, setTelemetryViewMode] = useState<'table' | 'raw'>('table');
  const [triggeringHealthCheck, setTriggeringHealthCheck] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Modal State for Installation Evidence Photo
  const [evidenceModalItem, setEvidenceModalItem] = useState<{
    gate: any;
    evidence: any;
    masterSeq?: number;
    deviceSeq?: number;
  } | null>(null);

  // Data State
  const [scopeGroups, setScopeGroups] = useState<ScopeGroupItem[]>([]);
  const [gates, setGates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Search, Filter & Sort State
  const [searchQuery, setSearchQuery] = useState('');
  const [filterScopeGroupId, setFilterScopeGroupId] = useState<string>('ALL');
  const [filterZone, setFilterZone] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<string>('lcNumber_asc');

  // Compute distinct zones from gates
  const availableZones = useMemo(() => {
    const set = new Set<string>();
    gates.forEach(g => {
      if (g.zone && g.zone.trim()) set.add(g.zone.trim());
    });
    return Array.from(set).sort();
  }, [gates]);

  // Compute distinct scope groups for filtering
  const availableScopeGroups = useMemo(() => {
    return scopeGroups.map(sg => ({ id: String(sg.id), name: sg.name }));
  }, [scopeGroups]);

  const isFilterActive = searchQuery.trim() !== '' || filterScopeGroupId !== 'ALL' || filterZone !== 'ALL' || sortBy !== 'lcNumber_asc';

  const handleResetFilters = () => {
    setSearchQuery('');
    setFilterScopeGroupId('ALL');
    setFilterZone('ALL');
    setSortBy('lcNumber_asc');
  };

  // Fetch Scope Groups and Gates
  const fetchData = async () => {
    setLoading(true);
    try {
      // 1. Fetch user scope hierarchy
      const scopeRes = await fetch(`${API_URL}/api/v1/scope-groups/my-scope`, { headers: authHeaders() });
      let myGroups: ScopeGroupItem[] = [];
      if (scopeRes.ok) {
        const scopeData = await scopeRes.json();
        myGroups = scopeData.allScopeGroups || scopeData.scopeGroups || [];
      }

      // 2. Fetch all groups list
      const groupsListRes = await fetch(`${API_URL}/api/v1/scope-groups`, { headers: authHeaders() });
      if (groupsListRes.ok) {
        const allGroups = await groupsListRes.json();
        if (Array.isArray(allGroups) && allGroups.length > 0) {
          setScopeGroups(allGroups);
        } else {
          setScopeGroups(myGroups);
        }
      } else {
        setScopeGroups(myGroups);
      }

      // 3. Fetch Gates scoped to user
      const gatesRes = await fetch(`${API_URL}/api/v1/lcgate`, { headers: authHeaders() });
      if (gatesRes.ok) {
        const gatesData = await gatesRes.json();
        setGates(Array.isArray(gatesData) ? gatesData : []);
      }
    } catch (err) {
      console.error('Failed to load LC Gates directory data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Compute total clusters inside a scope group recursively
  const getRecursiveClusterCount = (groupId: number): number => {
    const descendantIds = new Set<number>([groupId]);
    let queue = [groupId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = scopeGroups.filter(g => g.parentId === current);
      for (const child of children) {
        if (!descendantIds.has(child.id)) {
          descendantIds.add(child.id);
          queue.push(child.id);
        }
      }
    }

    return gates.filter(gate =>
      gate.scopeGroups?.some((sg: any) => descendantIds.has(sg.scopeGroupId || sg.scopeGroup?.id))
    ).length;
  };

  // Folders directly in current directory
  const currentFolders = useMemo(() => {
    let result = scopeGroups.filter(g => {
      if (currentFolderId === null) {
        return g.parentId === null || !g.parent;
      }
      return g.parentId === currentFolderId;
    });

    if (currentFolderId === null && filterScopeGroupId !== 'ALL') {
      result = result.filter(g => String(g.id) === filterScopeGroupId);
    }

    if (searchQuery.trim() || filterZone !== 'ALL') {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(g => {
        // Direct group name or description match
        const groupMatches = q && (
          g.name.toLowerCase().includes(q) ||
          (g.description && g.description.toLowerCase().includes(q))
        );
        if (groupMatches && filterZone === 'ALL') return true;

        // Check if any gate inside this group matches query and zone
        const hasMatchingCluster = gates.some(gate => {
          const inThisGroup = gate.scopeGroups?.some((sg: any) =>
            (sg.scopeGroupId || sg.scopeGroup?.id) === g.id
          );
          if (!inThisGroup) return false;

          if (filterZone !== 'ALL' && (gate.zone || '').trim() !== filterZone) {
            return false;
          }

          if (!q) return true;

          return (
            gate.lcNumber.toLowerCase().includes(q) ||
            (gate.name && gate.name.toLowerCase().includes(q)) ||
            (gate.locationName && gate.locationName.toLowerCase().includes(q)) ||
            (gate.zone && gate.zone.toLowerCase().includes(q)) ||
            (gate.division && gate.division.toLowerCase().includes(q))
          );
        });

        return hasMatchingCluster;
      });
    }

    return result;
  }, [scopeGroups, currentFolderId, filterScopeGroupId, searchQuery, filterZone, gates]);

  // Clusters directly in current scope group or matching search
  const currentClusters = useMemo(() => {
    let result: any[] = [];

    if (currentFolderId === null) {
      if (isFilterActive) {
        result = [...gates];
      } else {
        result = gates.filter(g => !g.scopeGroups || g.scopeGroups.length === 0);
      }
    } else {
      result = gates.filter(g =>
        g.scopeGroups?.some((sg: any) => (sg.scopeGroupId || sg.scopeGroup?.id) === currentFolderId)
      );
    }

    // Filter by Scope Group (if selected on landing page)
    if (currentFolderId === null && filterScopeGroupId !== 'ALL') {
      result = result.filter(g =>
        g.scopeGroups?.some((sg: any) => String(sg.scopeGroupId || sg.scopeGroup?.id) === filterScopeGroupId)
      );
    }

    // Filter by Zone
    if (filterZone !== 'ALL') {
      result = result.filter(g => (g.zone || '').trim() === filterZone);
    }

    // Filter by Search Query (LC number, Name, Zone, Location, Scope Group)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(g =>
        g.lcNumber.toLowerCase().includes(q) ||
        (g.name && g.name.toLowerCase().includes(q)) ||
        (g.locationName && g.locationName.toLowerCase().includes(q)) ||
        (g.zone && g.zone.toLowerCase().includes(q)) ||
        (g.division && g.division.toLowerCase().includes(q)) ||
        g.scopeGroups?.some((sg: any) => (sg.scopeGroup?.name || '').toLowerCase().includes(q))
      );
    }

    // Sort by chosen criteria
    result.sort((a, b) => {
      if (sortBy === 'lcNumber_asc') {
        return a.lcNumber.localeCompare(b.lcNumber, undefined, { numeric: true });
      }
      if (sortBy === 'lcNumber_desc') {
        return b.lcNumber.localeCompare(a.lcNumber, undefined, { numeric: true });
      }
      if (sortBy === 'name_asc') {
        const nameA = a.name || a.locationName || a.lcNumber;
        const nameB = b.name || b.locationName || b.lcNumber;
        return nameA.localeCompare(nameB);
      }
      if (sortBy === 'zone_asc') {
        const zoneA = `${a.zone || ''} ${a.division || ''}`;
        const zoneB = `${b.zone || ''} ${b.division || ''}`;
        return zoneA.localeCompare(zoneB);
      }
      return 0;
    });

    return result;
  }, [gates, currentFolderId, isFilterActive, filterScopeGroupId, filterZone, searchQuery, sortBy]);

  // Open Scope Group / Division folder
  const handleOpenScopeGroup = (group: ScopeGroupItem) => {
    setScopeGroupStack(prev => [...prev, group]);
    setSearchQuery('');
  };

  // Back from Scope Group (returns to previous scope group or Landing Page)
  const handleBackFromScopeGroup = () => {
    setScopeGroupStack(prev => prev.slice(0, -1));
    setSearchQuery('');
  };

  // Resolve parent Scope Group dynamically for cluster drilldown
  const parentScopeGroup = useMemo(() => {
    if (currentScopeGroup) return currentScopeGroup;
    if (selectedGate?.scopeGroups?.[0]) {
      const sgId = selectedGate.scopeGroups[0].scopeGroupId || selectedGate.scopeGroups[0].scopeGroup?.id;
      const found = scopeGroups.find(g => g.id === sgId);
      if (found) return found;
      if (selectedGate.scopeGroups[0].scopeGroup?.name) {
        return {
          id: sgId || 0,
          name: selectedGate.scopeGroups[0].scopeGroup.name,
          color: selectedGate.scopeGroups[0].scopeGroup.color
        } as ScopeGroupItem;
      }
    }
    return null;
  }, [currentScopeGroup, selectedGate, scopeGroups]);

  const parentScopeGroupName = parentScopeGroup?.name || 'Scope Groups';

  // Back from Cluster Details (returns to parent Scope Group)
  const handleBackFromCluster = () => {
    if (parentScopeGroup && scopeGroupStack.length === 0) {
      setScopeGroupStack([parentScopeGroup]);
    }
    setViewMode('folder');
    setSelectedGate(null);
  };

  // Open cluster drilldown in "About & Manifest" mode
  const handleOpenClusterAbout = (gate: any) => {
    setSelectedGate(gate);
    setClusterTab('about_manifest');
    setViewMode('detail');
  };

  // Open cluster drilldown in "AWS Telemetry" mode
  const handleOpenClusterTelemetry = (gate: any) => {
    setSelectedGate(gate);
    setClusterTab('telemetry');
    setViewMode('detail');
  };

  // Fetch real-time telemetry from backend for the gate
  const fetchGateTelemetry = useCallback(async (gateId: number, silent = false) => {
    if (!silent) setLoadingTelemetry(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${gateId}/telemetry`, {
        headers: authHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        setGateTelemetry(data);
      }
    } catch (err) {
      console.error('Failed to load gate telemetry', err);
    } finally {
      if (!silent) setLoadingTelemetry(false);
    }
  }, []);

  // Live WebSocket connection for real-time telemetry streaming
  useEffect(() => {
    if (viewMode !== 'detail' || !selectedGate || clusterTab !== 'telemetry') {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsConnected(false);
      return;
    }

    const gateId = selectedGate.id;
    let wsUrl: string;
    try {
      const parsed = new URL(API_URL);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${parsed.host}/ws/telemetry?gateId=${gateId}`;
    } catch {
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${wsProto}//${window.location.hostname}:5001/ws/telemetry?gateId=${gateId}`;
    }

    let isMounted = true;
    let reconnectTimeout: any = null;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setWsConnected(true);
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'telemetry_init' || msg.type === 'telemetry_update') {
              if (msg.data) {
                setGateTelemetry(msg.data);
                setLoadingTelemetry(false);
              }
            }
          } catch (e) {
            console.warn('WS message parse error:', e);
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setWsConnected(false);
          reconnectTimeout = setTimeout(() => {
            if (isMounted) connectWebSocket();
          }, 3000);
        };

        ws.onerror = () => {
          if (!isMounted) return;
          setWsConnected(false);
          ws.close();
        };
      } catch (err) {
        console.warn('Failed to establish WebSocket:', err);
      }
    };

    connectWebSocket();
    fetchGateTelemetry(gateId, false);

    return () => {
      isMounted = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsConnected(false);
    };
  }, [viewMode, selectedGate, clusterTab, fetchGateTelemetry]);

  // Trigger health check command to physical gate hardware with hardware poll
  const handleTriggerHealthCheck = async () => {
    if (!selectedGate) return;
    setTriggeringHealthCheck(true);
    setHealthCheckStage('DISPATCHING');
    setInspectSubTab('health');

    const triggerStartTime = Date.now();
    const initialMaxId = healthRecords.length > 0
      ? Math.max(...healthRecords.map((h: any) => typeof h.id === 'number' ? h.id : 0))
      : 0;

    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${selectedGate.id}/health-check`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || 'Failed to ping gate', 'Health Check');
        setTriggeringHealthCheck(false);
        setHealthCheckStage('IDLE');
        return;
      }

      toastSuccess(`Diagnostic ping sent to ${data.topic || 'AWS IoT Core'}. Awaiting hardware packet...`, 'Command Dispatched');
      setHealthCheckStage('LISTENING');

      let attempts = 0;
      const maxAttempts = 12;
      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const pollRes = await fetch(`${API_URL}/api/v1/lcgate/${selectedGate.id}/telemetry`, {
            headers: authHeaders()
          });
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            const hcs: any[] = pollData.healthRecords || [];
            const payloads: any[] = pollData.payloads || [];

            const matchingCheck = hcs.find((c: any) => {
              const isResponse = c.payload?.action === 'HEALTH_CHECK_RESPONSE' ||
                                 c.gateStatus !== null ||
                                 c.boomAngle !== null ||
                                 c.healthstatus !== undefined ||
                                 (c.status && c.status !== 'REQUESTED' && c.status !== 'PENDING');
              if (!isResponse) return false;
              const isNewId = c.id && c.id > initialMaxId;
              const isMatchingReq = Boolean(data.requestId && (c.requestId === data.requestId || c.payload?.requestId === data.requestId));
              const recTime = new Date(c.receivedAt || c.createdAt).getTime();
              const isWithinWindow = recTime >= triggerStartTime - 10000;
              return isNewId || isMatchingReq || isWithinWindow;
            });

            if (matchingCheck) {
              clearInterval(pollInterval);
              setTriggeringHealthCheck(false);
              setHealthCheckStage('SUCCESS');
              setGateTelemetry(pollData);
              setSelectedPayloadId(matchingCheck.id);
              toastSuccess(`Live response received from ${selectedGate.lcNumber}! Barrier: ${matchingCheck.gateStatus || matchingCheck.payload?.gateStatus || 'REPORTED'} | Verdict: ${matchingCheck.status || matchingCheck.healthstatus || 'HEALTHY'}`, 'Device Verified');
              return;
            }

            const foundInPayloads = payloads.find((p: any) => {
              const recTime = new Date(p.receivedAt).getTime();
              const isMatch = (data.requestId && p.payload?.requestId === data.requestId) || (recTime >= triggerStartTime - 1000);
              const isHealth = (p.topic || '').includes('/health') || p.payload?.action === 'HEALTH_CHECK_RESPONSE' || p.payload?.healthstatus !== undefined;
              const isNotRequestedOnly = p.status !== 'REQUESTED' && p.status !== 'PENDING';
              return isMatch && isHealth && isNotRequestedOnly;
            });

            if (foundInPayloads) {
              clearInterval(pollInterval);
              setTriggeringHealthCheck(false);
              setHealthCheckStage('SUCCESS');
              setGateTelemetry(pollData);
              setSelectedPayloadId(foundInPayloads.id);
              toastSuccess(`Live response received from ${selectedGate.lcNumber}! Verdict: ${foundInPayloads.payload?.healthstatus || 'HEALTHY'}`, 'Device Verified');
              return;
            }
          }
        } catch (e) {
          console.warn('Health poll attempt failed', e);
        }

        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          setTriggeringHealthCheck(false);
          setHealthCheckStage('TIMEOUT');
          await fetchGateTelemetry(selectedGate.id, true);
        }
      }, 1500);
    } catch (err: any) {
      toastError(err.message || 'Error triggering health check', 'Health Check');
      setTriggeringHealthCheck(false);
      setHealthCheckStage('IDLE');
    }
  };

  const allHistoricPayloads: any[] = useMemo(() => gateTelemetry?.payloads || [], [gateTelemetry]);
  const telemetryRecords: any[] = useMemo(() => gateTelemetry?.telemetryRecords || [], [gateTelemetry]);
  const manifestRecords: any[] = useMemo(() => gateTelemetry?.manifestRecords || [], [gateTelemetry]);
  const healthRecords: any[] = useMemo(() => gateTelemetry?.healthRecords || [], [gateTelemetry]);
  const operationalCycles: any[] = useMemo(() => gateTelemetry?.operationalCycles || [], [gateTelemetry]);
  const currentOperationalState = useMemo(() => gateTelemetry?.currentOperationalState || null, [gateTelemetry]);

  const currentViewingCycle = useMemo(() => {
    if (selectedCycleId !== null) {
      const found = operationalCycles.find((c: any) => c.id === selectedCycleId);
      if (found) return found;
    }
    return operationalCycles[0] || null;
  }, [selectedCycleId, operationalCycles]);

  const activeRecordList = useMemo(() => {
    if (inspectSubTab === 'telemetry') return telemetryRecords;
    if (inspectSubTab === 'manifest') return manifestRecords;
    if (inspectSubTab === 'health') return healthRecords;
    return allHistoricPayloads;
  }, [inspectSubTab, telemetryRecords, manifestRecords, healthRecords, allHistoricPayloads]);

  const currentViewingRecord = useMemo(() => {
    if (selectedPayloadId !== null) {
      const found = allHistoricPayloads.find((p: any) => p.id === selectedPayloadId);
      if (found) return found;
      const foundInHc = healthRecords.find((h: any) => h.id === selectedPayloadId);
      if (foundInHc) return foundInHc;
    }
    if (activeRecordList.length > 0) return activeRecordList[0];
    if (inspectSubTab === 'manifest' && gateTelemetry?.latestManifest) {
      return gateTelemetry.latestManifest;
    }
    if (inspectSubTab === 'health' && gateTelemetry?.latestHealthCheck) {
      return gateTelemetry.latestHealthCheck;
    }
    return gateTelemetry?.latestTelemetry || null;
  }, [selectedPayloadId, allHistoricPayloads, healthRecords, activeRecordList, inspectSubTab, gateTelemetry]);

  // Helper to extract first evidence photo for a gate
  const getGateInstallationEvidence = (gate: any) => {
    for (const master of gate.masters || []) {
      if (master.evidences && master.evidences.length > 0) {
        return { evidence: master.evidences[0], masterSeq: master.masterSequence };
      }
      for (const child of master.childDevices || []) {
        if (child.evidences && child.evidences.length > 0) {
          return {
            evidence: child.evidences[0],
            masterSeq: master.masterSequence,
            deviceSeq: child.deviceSequence
          };
        }
      }
    }
    return null;
  };


  return (
    <div className="lcg-container">
      {/* 1. CLEAN & LIGHTWEIGHT HEADER */}
      <div className="lcg-header-light">
        <div className="lcg-header-info">
          <div className="lcg-header-title" style={{ margin: 0 }}>
            <FaArchway />
            <span>LC Gates</span>
          </div>
        </div>
      </div>

      {/* 2. NAVIGATION & TOOLBAR (SINGLE ROW ALIGNED) */}
      <div className="lcg-nav-toolbar">
        {viewMode === 'detail' && selectedGate ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
              <button
                type="button"
                className="lcg-context-back-btn"
                onClick={handleBackFromCluster}
                title={`Back to ${parentScopeGroupName}`}
              >
                <FaArrowLeft size={11} />
                <span>Back</span>
              </button>
            </div>

            <div className="lcg-toolbar-right">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className={`lcg-power-pill ${selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? 'solar' : 'direct'}`} style={{ fontSize: '0.8rem' }}>
                  {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? <FaSun /> : <FaBolt />}
                  {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? ' Solar Powered' : ' Direct AC'}
                </span>
                <button
                  type="button"
                  className="btn-small btn-outline"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '5px 12px', borderRadius: 7 }}
                  onClick={() => fetchGateTelemetry(selectedGate.id)}
                  title="Refresh live cluster telemetry"
                >
                  <FaSyncAlt className={loadingTelemetry ? 'fa-spin' : ''} size={11} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="lcg-toolbar-filter-row">
            {/* Context Back Button (if inside a Scope Group) */}
            {currentScopeGroup !== null && (
              <button
                type="button"
                className="lcg-context-back-btn"
                onClick={handleBackFromScopeGroup}
                title="Back"
              >
                <FaArrowLeft size={11} />
                <span>Back</span>
              </button>
            )}

            {/* Comprehensive Search Input */}
            <div className="lcg-search-input-wrap">
              <FaSearch className="lcg-search-icon" />
              <input
                type="text"
                className="lcg-search-input"
                placeholder={currentScopeGroup
                  ? `Search ${currentScopeGroup.name} (Gate #, Name, Zone, Location)...`
                  : 'Search by LC Gate Number, Name, Zone, Location, Scope Group...'}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  style={{ position: 'absolute', right: 10, background: 'transparent', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 2 }}
                  title="Clear search text"
                >
                  <FaTimes size={11} />
                </button>
              )}
            </div>

            {/* Scope Group Filter (on landing page) */}
            {currentScopeGroup === null && availableScopeGroups.length > 1 && (
              <select
                className="lcg-filter-select"
                value={filterScopeGroupId}
                onChange={e => setFilterScopeGroupId(e.target.value)}
                title="Filter by Scope Group"
              >
                <option value="ALL">All Scope Groups ({availableScopeGroups.length})</option>
                {availableScopeGroups.map(sg => (
                  <option key={sg.id} value={sg.id}>{sg.name}</option>
                ))}
              </select>
            )}

            {/* Zone Filter */}
            {availableZones.length > 0 && (
              <select
                className="lcg-filter-select"
                value={filterZone}
                onChange={e => setFilterZone(e.target.value)}
                title="Filter by Railway Zone"
              >
                <option value="ALL">All Railway Zones ({availableZones.length})</option>
                {availableZones.map(zone => (
                  <option key={zone} value={zone}>{zone}</option>
                ))}
              </select>
            )}

            {/* Sort Dropdown */}
            <select
              className="lcg-filter-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              title="Sort items"
            >
              <option value="lcNumber_asc">Sort: LC Gate # (A → Z)</option>
              <option value="lcNumber_desc">Sort: LC Gate # (Z → A)</option>
              <option value="name_asc">Sort: Name / Location</option>
              <option value="zone_asc">Sort: Railway Zone</option>
            </select>

            {/* Clear / Reset Filters Button (when any active) */}
            {isFilterActive && (
              <button
                type="button"
                className="lcg-clear-btn"
                onClick={handleResetFilters}
                title="Reset all search and filter options"
              >
                <FaTimes size={11} />
                <span>Reset</span>
              </button>
            )}

            {/* Refresh Button */}
            <button
              type="button"
              className="btn btn-secondary btn-sm lcg-refresh-btn"
              style={{ height: 38, padding: '0 14px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={fetchData}
              disabled={loading}
              title="Refresh directory data"
            >
              <FaSyncAlt className={loading ? 'fa-spin' : ''} size={12} />
              <span>Refresh</span>
            </button>
          </div>
        )}
      </div>

      {/* 3. MAIN CONTENT VIEWS */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
          <FaSyncAlt className="spin" size={30} style={{ marginBottom: 12, color: '#0B3C7A' }} />
          <div style={{ fontWeight: 700, fontSize: '1rem', color: '#1e293b' }}>Loading LC Gates directory...</div>
        </div>
      ) : viewMode === 'detail' && selectedGate ? (
        /* DETAIL VIEW: CLUSTER DRILLDOWN */
        <div className="lcg-detail-container">
          {/* Gate Header Card */}
          <div style={{ background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', padding: 18, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span className="lcg-lc-badge">
                    <FaArchway /> {selectedGate.lcNumber}
                  </span>
                  <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, color: '#0f172a' }}>
                    {selectedGate.name || selectedGate.locationName}
                  </h2>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, color: '#64748b', fontSize: '0.86rem' }}>
                  <span><FaTrain style={{ marginRight: 4 }} /> Zone: <strong>{selectedGate.zone || 'CR'}</strong></span>
                  <span>•</span>
                  <span>Division: <strong>{selectedGate.division || 'Mumbai'}</strong></span>
                  {selectedGate.latitude && selectedGate.longitude && (
                    <>
                      <span>•</span>
                      <span>
                        <FaMapMarkerAlt style={{ marginRight: 4, color: '#ef4444' }} />
                        <a
                          href={`https://www.google.com/maps?q=${selectedGate.latitude},${selectedGate.longitude}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#0284c7', textDecoration: 'none' }}
                          title="Open in Google Maps"
                        >
                          {selectedGate.latitude.toFixed(5)}, {selectedGate.longitude.toFixed(5)} <FaExternalLinkAlt size={9} />
                        </a>
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Scope Group assignment tags */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {selectedGate.scopeGroups?.map((sg: any) => (
                  <span
                    key={sg.id}
                    style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', fontSize: '0.76rem', fontWeight: 700, padding: '3px 8px', borderRadius: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <FaFolder size={10} /> {sg.scopeGroup?.name || 'Assigned Scope Group'}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Segmented Navigation Tabs */}
          <div className="lcg-detail-nav-tabs">
            <button
              type="button"
              className={`lcg-tab-button ${clusterTab === 'about_manifest' ? 'active' : ''}`}
              onClick={() => setClusterTab('about_manifest')}
            >
              <FaInfoCircle size={14} />
              <span>About LC Gate & Hardware Manifest</span>
            </button>
            <button
              type="button"
              className={`lcg-tab-button ${clusterTab === 'telemetry' ? 'active' : ''}`}
              onClick={() => setClusterTab('telemetry')}
            >
              <FaSlidersH size={14} />
              <span>Live Telemetry & Inspector</span>
            </button>
          </div>

          {/* Tab Content */}
          {clusterTab === 'about_manifest' ? (
            /* ================= ABOUT CLUSTER & HARDWARE MANIFEST UNIFIED VIEW ================= */
            <div>
              <div className="lcg-about-grid">
                {/* Location & Geographic Details Card */}
                <div className="lcg-about-card">
                  <div className="lcg-about-card-title">
                    <FaMapMarkerAlt color="#ef4444" />
                    <span>Geographical Location</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">LC Gate Number</span>
                    <span className="lcg-about-field-value">{selectedGate.lcNumber}</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Railway Zone</span>
                    <span className="lcg-about-field-value">{selectedGate.zone || 'CR'}</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Railway Division</span>
                    <span className="lcg-about-field-value">{selectedGate.division || 'Mumbai'}</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Location / Station</span>
                    <span className="lcg-about-field-value">{selectedGate.name || selectedGate.locationName}</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">GPS Geotag</span>
                    <span className="lcg-about-field-value">
                      {selectedGate.latitude && selectedGate.longitude ? (
                        <a
                          href={`https://www.google.com/maps?q=${selectedGate.latitude},${selectedGate.longitude}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: '#0284c7', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          {selectedGate.latitude.toFixed(5)}, {selectedGate.longitude.toFixed(5)}
                          <FaExternalLinkAlt size={9} />
                        </a>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>Not Specified</span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Cluster Hardware Architecture */}
                <div className="lcg-about-card">
                  <div className="lcg-about-card-title">
                    <FaMicrochip color="#0B3C7A" />
                    <span>Hardware Configuration</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Primary Power</span>
                    <span className="lcg-about-field-value">
                      <span className={`lcg-power-pill ${selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? 'solar' : 'direct'}`} style={{ fontSize: '0.74rem' }}>
                        {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? <FaSun /> : <FaBolt />}
                        {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? ' Solar Powered' : ' Direct AC Mains'}
                      </span>
                    </span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Configured Masters</span>
                    <span className="lcg-about-field-value">{selectedGate.masters?.length || 0} Gateway Unit(s)</span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">Connected Slave Sensors</span>
                    <span className="lcg-about-field-value">
                      {selectedGate.masters?.reduce((acc: number, m: any) => acc + (m.childDevices?.length || 0), 0) || 0} Device(s)
                    </span>
                  </div>
                  <div className="lcg-about-field-row">
                    <span className="lcg-about-field-label">System Status</span>
                    <span className="lcg-about-field-value" style={{ color: '#059669', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <FaCheckCircle /> Configured
                    </span>
                  </div>
                </div>
              </div>

              {/* 2. Physical Device Manifest & Gateway Profile */}
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '18px 20px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#e0f2fe', color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>
                      <FaShieldAlt />
                    </div>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#0f172a' }}>
                        Physical Device Manifest Profile ({selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber})
                      </h4>
                      <span style={{ fontSize: '0.76rem', color: '#64748b' }}>
                        Dynamic hardware specifications ingested from edge boot payload & AWS IoT registry
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setDeviceInfoItem({ gate: selectedGate, master: selectedGate.masters?.[0] })}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', fontSize: '0.8rem', fontWeight: 700 }}
                    title="Inspect complete JSON hardware manifest"
                  >
                    <FaCode /> View Raw Manifest JSON
                  </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, background: '#f8fafc', padding: 14, borderRadius: 10, border: '1px solid #f1f5f9' }}>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Serial Number</span>
                    <div style={{ fontSize: '0.98rem', fontWeight: 800, color: 'var(--primary)' }}>
                      {selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Device Name</span>
                    <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#0f172a' }}>
                      {selectedGate.deviceRegistries?.[0]?.attributes?.deviceName || 'LC Gate'}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Manufacturing Date</span>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#0f172a' }}>
                      {selectedGate.deviceRegistries?.[0]?.dateOfMfg ? new Date(selectedGate.deviceRegistries[0].dateOfMfg).toLocaleDateString() : (selectedGate.createdAt ? new Date(selectedGate.createdAt).toLocaleDateString() : 'N/A')}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Firmware Version</span>
                    <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#0f172a' }}>
                      v{selectedGate.deviceRegistries?.[0]?.firmwareVersion || selectedGate.masters?.[0]?.firmwareVersion || '1.0.6'}
                    </div>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Description</span>
                    <div style={{ fontSize: '0.84rem', color: '#334155', marginTop: 2 }}>
                      {selectedGate.deviceRegistries?.[0]?.attributes?.description || 'Installed on Indian Railways Level Crossings'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Master Units and Hardware Topology */}
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0f172a', marginBottom: 12 }}>
                  Configured Hardware Devices Topology
                </h3>

                {(!selectedGate.masters || selectedGate.masters.length === 0) ? (
                  <div className="lcg-empty-box">
                    <FaMicrochip className="lcg-empty-icon" />
                    <h4 style={{ margin: '0 0 4px 0', color: '#1e293b' }}>No Master Devices Configured</h4>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      This cluster currently does not have master hardware units configured.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {selectedGate.masters.map((master: any) => {
                      return (
                        <div
                          key={master.id}
                          style={{
                            background: '#ffffff',
                            border: '1px solid #e2e8f0',
                            borderRadius: 12,
                            padding: 16,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
                          }}
                        >
                          {/* Master Unit Header Row */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#e0f2fe', color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>
                                <FaMicrochip />
                              </div>
                              <div>
                                <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#0f172a' }}>
                                  Master #{master.masterSequence}: {master.serialNumber}
                                </h4>
                                <span style={{ fontSize: '0.76rem', color: '#64748b' }}>
                                  Primary Gateway Unit • {master.powerSource === 'SOLAR' ? 'Solar Powered' : 'Direct AC Power'}
                                </span>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                style={{ padding: '4px 10px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 5, borderRadius: 6 }}
                                onClick={() => setDeviceInfoItem({ master, gate: selectedGate })}
                                title="View full device manifest and hardware specifications"
                              >
                                <FaMicrochip /> Device Info
                              </button>

                              <span className={`lcg-power-pill ${master.powerSource === 'SOLAR' ? 'solar' : 'direct'}`}>
                                {master.powerSource === 'SOLAR' ? <FaSun /> : <FaBolt />} {master.powerSource}
                              </span>
                            </div>
                          </div>

                          {/* Master Unit Installation Evidence Section */}
                          <div className="lcg-topology-evidence-panel">
                            <div className="lcg-topology-evidence-header">
                              <div className="lcg-topology-evidence-title">
                                <FaCamera color="#0B3C7A" />
                                <span>Installation Evidence for Master #{master.masterSequence} ({master.evidences?.length || 0})</span>
                              </div>
                              {master.evidences && master.evidences.length > 0 && (
                                <span style={{ fontSize: '0.72rem', color: '#059669', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <FaCheckCircle size={11} /> Evidence Recorded
                                </span>
                              )}
                            </div>

                            {(!master.evidences || master.evidences.length === 0) ? (
                              <div style={{ fontSize: '0.76rem', color: '#94a3b8', fontStyle: 'italic', padding: '3px 0' }}>
                                No installation evidence photo uploaded for Master #{master.masterSequence} yet.
                              </div>
                            ) : (
                              <div className="lcg-topology-evidence-items">
                                {master.evidences.map((ev: any, evIdx: number) => (
                                  <div
                                    key={ev.id || evIdx}
                                    className="lcg-topology-evidence-card"
                                    onClick={() => setEvidenceModalItem({
                                      gate: selectedGate,
                                      evidence: ev,
                                      masterSeq: master.masterSequence
                                    })}
                                    title="Click to inspect full installation photo"
                                  >
                                    <img
                                      src={getFullImageUrl(ev.imageUrl)}
                                      alt="Evidence"
                                      className="lcg-topology-evidence-img"
                                      onError={(e: any) => { e.target.style.display = 'none'; }}
                                    />
                                    <div>
                                      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#0f172a' }}>
                                        {ev.category === 'MASTER' ? 'Master Gateway Unit Photo' :
                                         ev.category === 'POWER_SOURCE' ? 'Power / Solar Source Photo' :
                                         ev.category === 'SIM_CARD' ? 'SIM Card Photo' :
                                         `${ev.category || 'Equipment'} Photo`}
                                      </div>
                                      <div style={{ fontSize: '0.7rem', color: '#64748b', marginBottom: 4 }}>
                                        {ev.latitude && ev.longitude
                                          ? `GPS: ${ev.latitude.toFixed(4)}, ${ev.longitude.toFixed(4)}`
                                          : 'Site Photo Attached'}
                                      </div>
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        style={{ padding: '2px 8px', fontSize: '0.68rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setEvidenceModalItem({
                                            gate: selectedGate,
                                            evidence: ev,
                                            masterSeq: master.masterSequence
                                          });
                                        }}
                                      >
                                        <FaEye size={9} /> View Photo
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Slave Devices Topology & Evidence */}
                          <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 8, border: '1px solid #f1f5f9' }}>
                            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                              <FaPlug color="#0284c7" /> Connected Slave Devices ({master.childDevices?.length || 0})
                            </div>

                            {(!master.childDevices || master.childDevices.length === 0) ? (
                              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No slave devices linked to this master.</span>
                            ) : (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
                                {master.childDevices.map((child: any) => {
                                  const childEvidence = child.evidences?.[0];
                                  return (
                                    <div
                                      key={child.id}
                                      style={{
                                        background: '#ffffff',
                                        border: '1px solid #e2e8f0',
                                        borderRadius: 8,
                                        padding: '8px 12px',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: 10
                                      }}
                                    >
                                      <div>
                                        <div style={{ fontWeight: 700, fontSize: '0.84rem', color: '#0f172a' }}>
                                          {child.serialNumber}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                                          {child.type} • Sequence #{child.deviceSequence}
                                        </div>
                                      </div>

                                      {/* Installation Evidence for Slave */}
                                      {childEvidence ? (
                                        <div
                                          className="lcg-slave-evidence-chip"
                                          onClick={() => setEvidenceModalItem({
                                            gate: selectedGate,
                                            evidence: childEvidence,
                                            masterSeq: master.masterSequence,
                                            deviceSeq: child.deviceSequence
                                          })}
                                          title="Click to view slave installation photo"
                                        >
                                          <img
                                            src={getFullImageUrl(childEvidence.imageUrl)}
                                            alt="Slave Evidence"
                                            className="lcg-slave-evidence-thumb"
                                            onError={(e: any) => { e.target.style.display = 'none'; }}
                                          />
                                          <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            style={{ padding: '2px 6px', fontSize: '0.68rem', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEvidenceModalItem({
                                                gate: selectedGate,
                                                evidence: childEvidence,
                                                masterSeq: master.masterSequence,
                                                deviceSeq: child.deviceSequence
                                              });
                                            }}
                                          >
                                            <FaEye size={9} /> Evidence
                                          </button>
                                        </div>
                                      ) : (
                                        <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                          <FaCamera size={10} /> Pending
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ================= LIVE TELEMETRY & OPERATIONAL INSPECTOR SECTION ================= */
            <div className="lcg-telemetry-inspector-container">
              {/* Top Inspector Header Card */}
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#0f172a' }}>
                      {gateTelemetry?.thingName || selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}
                    </h3>
                    <span className="badge badge-indigo" style={{ fontSize: '0.76rem', padding: '3px 9px' }}>
                      AWS IoT Core
                    </span>
                    {(selectedGate.locationName || selectedGate.name) && (
                      <span style={{ fontSize: '0.84rem', fontWeight: 600, color: '#475569' }}>
                        {selectedGate.locationName || selectedGate.name}
                      </span>
                    )}
                    <span
                      style={{
                        padding: '3px 12px',
                        borderRadius: 6,
                        fontWeight: 800,
                        fontSize: '0.8rem',
                        letterSpacing: '0.3px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        background: (gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                        color: (gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c',
                        border: `1px solid ${(gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#86efac' : '#fca5a5'}`
                      }}
                    >
                      <span
                        className="pulse-dot"
                        style={{
                          width: 7,
                          height: 7,
                          background: (gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c'
                        }}
                      />
                      {(gateTelemetry?.currentStatus || 'CLOSED').toUpperCase()}
                    </span>
                  </div>
                </div>

                {/* Live Stream Status & Action Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {/* Live WebSocket Connection Status Badge */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '6px 14px',
                      borderRadius: 6,
                      background: wsConnected ? '#ecfdf5' : '#fef2f2',
                      border: `1px solid ${wsConnected ? '#a7f3d0' : '#fecaca'}`,
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: wsConnected ? '#065f46' : '#991b1b',
                    }}
                    title={wsConnected ? 'Connected to live WebSocket stream' : 'Reconnecting to live WebSocket...'}
                  >
                    <span
                      className={wsConnected ? 'pulse-dot' : ''}
                      style={{
                        width: 7,
                        height: 7,
                        background: wsConnected ? '#10b981' : '#ef4444',
                        borderRadius: '50%',
                        display: 'inline-block',
                      }}
                    />
                    {wsConnected ? 'Live Stream Connected' : 'Reconnecting...'}
                  </div>


                </div>
              </div>

              {/* Gate Operational Lifecycle Analytics KPI Banner */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginTop: 14 }}>
                {/* 1. Live Gate Operational State */}
                <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                    Current Gate Status
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 12px',
                        borderRadius: 6,
                        fontWeight: 800,
                        fontSize: '0.88rem',
                        background: (currentOperationalState?.currentStatus || gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                        color: (currentOperationalState?.currentStatus || gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c',
                        border: `1px solid ${(currentOperationalState?.currentStatus || gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#86efac' : '#fca5a5'}`
                      }}
                    >
                      <span
                        className="pulse-dot"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: (currentOperationalState?.currentStatus || gateTelemetry?.currentStatus || 'CLOSED').toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c'
                        }}
                      />
                      {(currentOperationalState?.currentStatus || gateTelemetry?.currentStatus || 'CLOSED').toUpperCase()}
                    </span>
                    <span style={{ fontSize: '0.78rem', color: '#64748b', fontWeight: 600 }}>
                      {currentOperationalState?.timeInCurrentStateFormatted ? `for ${currentOperationalState.timeInCurrentStateFormatted}` : ''}
                    </span>
                  </div>
                </div>

                {/* 2. Last Gate Opened */}
                <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                    Last Opened At
                  </div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a' }}>
                    {operationalCycles[0]?.openedAt ? new Date(operationalCycles[0].openedAt).toLocaleTimeString() : '—'}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                    {operationalCycles[0]?.openedAt ? `${new Date(operationalCycles[0].openedAt).toLocaleDateString()} • ${operationalCycles[0].openedBy || 'IoT Telemetry'}` : 'No cycle recorded'}
                  </div>
                </div>

                {/* 3. Last Gate Closed */}
                <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                    Last Closed At
                  </div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a' }}>
                    {currentOperationalState?.lastClosedCycle?.closedAt
                      ? new Date(currentOperationalState.lastClosedCycle.closedAt).toLocaleTimeString()
                      : (operationalCycles[0]?.closedAt ? new Date(operationalCycles[0].closedAt).toLocaleTimeString() : 'Active (Open)')}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                    {currentOperationalState?.lastClosedCycle?.closedAt
                      ? `${new Date(currentOperationalState.lastClosedCycle.closedAt).toLocaleDateString()} • Closed & Locked`
                      : 'Awaiting closure'}
                  </div>
                </div>

                {/* 4. Last Operational Cycle Duration */}
                <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
                    Last Cycle Duration
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0B3C7A' }}>
                      {currentOperationalState?.lastClosedCycle?.formattedDuration || '—'}
                    </div>
                    {currentOperationalState?.lastClosedCycle && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontWeight: 700,
                          background: currentOperationalState.lastClosedCycle.status === 'EXTENDED_DELAY' ? '#fef3c7' : '#ecfdf5',
                          color: currentOperationalState.lastClosedCycle.status === 'EXTENDED_DELAY' ? '#b45309' : '#047857',
                          border: `1px solid ${currentOperationalState.lastClosedCycle.status === 'EXTENDED_DELAY' ? '#fde68a' : '#a7f3d0'}`
                        }}
                      >
                        {currentOperationalState.lastClosedCycle.status === 'EXTENDED_DELAY' ? 'Extended Delay' : 'Normal'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                    {currentOperationalState?.lastClosedCycle?.durationSeconds ? `${currentOperationalState.lastClosedCycle.durationSeconds}s open-to-close` : 'Cycle duration'}
                  </div>
                </div>
              </div>

              {/* Sub-header Navigation Tabs */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', padding: '12px 0 10px 0', marginTop: 14, flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`telemetry-tab-btn ${inspectSubTab === 'telemetry' ? 'active' : ''}`}
                    onClick={() => { setInspectSubTab('telemetry'); setSelectedPayloadId(null); }}
                  >
                    <FaBroadcastTower size={13} />
                    <span>Telemetry</span>
                    <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                      {telemetryRecords.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`telemetry-tab-btn ${inspectSubTab === 'manifest' ? 'active' : ''}`}
                    onClick={() => { setInspectSubTab('manifest'); setSelectedPayloadId(null); }}
                  >
                    <FaFileAlt size={13} />
                    <span>Manifest</span>
                    <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                      {manifestRecords.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`telemetry-tab-btn ${inspectSubTab === 'health' ? 'active' : ''}`}
                    onClick={() => { setInspectSubTab('health'); setSelectedPayloadId(null); }}
                  >
                    <FaHeartbeat size={13} />
                    <span>Health Check</span>
                    <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                      {healthRecords.length}
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`telemetry-tab-btn ${inspectSubTab === 'all' ? 'active' : ''}`}
                    onClick={() => { setInspectSubTab('all'); setSelectedPayloadId(null); }}
                  >
                    <FaServer size={13} />
                    <span>All Records ({allHistoricPayloads.length})</span>
                  </button>

                  <button
                    type="button"
                    className={`telemetry-tab-btn ${inspectSubTab === 'cycles' ? 'active' : ''}`}
                    onClick={() => { setInspectSubTab('cycles'); setSelectedCycleId(null); }}
                  >
                    <FaHistory size={13} />
                    <span>Operational Cycles</span>
                    <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                      {operationalCycles.length}
                    </span>
                  </button>
                </div>

                {/* View Format Toggle (Table vs Raw JSON) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: 6, border: '1px solid #cbd5e1', display: 'flex' }}>
                    <button
                      type="button"
                      className={`telemetry-tab-btn ${telemetryViewMode === 'table' ? 'active' : ''}`}
                      style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                      onClick={() => setTelemetryViewMode('table')}
                    >
                      <FaTable size={11} /> Table View
                    </button>
                    <button
                      type="button"
                      className={`telemetry-tab-btn ${telemetryViewMode === 'raw' ? 'active' : ''}`}
                      style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                      onClick={() => setTelemetryViewMode('raw')}
                    >
                      <FaCode size={11} /> Raw JSON
                    </button>
                  </div>

                  {currentViewingRecord?.payload && (
                    <button
                      type="button"
                      className="btn-small btn-outline"
                      style={{ fontSize: '0.75rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 5, borderRadius: 6 }}
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(currentViewingRecord.payload, null, 2));
                        setIsCopied(true);
                        setTimeout(() => setIsCopied(false), 2000);
                        toastSuccess('Payload copied to clipboard', 'Copied');
                      }}
                    >
                      {isCopied ? <FaCheck color="#10b981" /> : <FaCopy />} {isCopied ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
              </div>

              {/* Body Content */}
              <div style={{ marginTop: 14 }}>
                {loadingTelemetry && allHistoricPayloads.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)' }}>
                    <FaSyncAlt className="fa-spin" size={26} style={{ color: '#0B3C7A', marginBottom: 10 }} />
                    <div style={{ fontWeight: 700, color: '#1e293b' }}>Loading live operational telemetry from edge device...</div>
                  </div>
                ) : inspectSubTab === 'cycles' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Active or Selected Operational Cycle Lifecycle Breakdown Card */}
                    {currentViewingCycle ? (
                      <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 8, padding: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: '0.98rem', fontWeight: 800, color: '#0f172a' }}>
                              Cycle #{currentViewingCycle.id} Operational Lifecycle
                            </span>
                            <span
                              style={{
                                padding: '3px 10px',
                                borderRadius: 4,
                                fontWeight: 800,
                                fontSize: '0.78rem',
                                background: currentViewingCycle.status === 'OPEN' ? '#fee2e2' : currentViewingCycle.status === 'EXTENDED_DELAY' ? '#fef3c7' : '#dcfce7',
                                color: currentViewingCycle.status === 'OPEN' ? '#b91c1c' : currentViewingCycle.status === 'EXTENDED_DELAY' ? '#b45309' : '#15803d',
                                border: `1px solid ${currentViewingCycle.status === 'OPEN' ? '#fca5a5' : currentViewingCycle.status === 'EXTENDED_DELAY' ? '#fde68a' : '#86efac'}`
                              }}
                            >
                              {currentViewingCycle.status === 'OPEN' ? 'OPEN • IN PROGRESS' : currentViewingCycle.status === 'EXTENDED_DELAY' ? 'EXTENDED DELAY (>15 MIN)' : 'CLOSED • NORMAL CLEARANCE'}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>Recorded on</span>
                            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#334155' }}>
                              {new Date(currentViewingCycle.openedAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>

                        {/* 3-Step Lifecycle Visual Journey */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, background: '#f8fafc', padding: 14, borderRadius: 8, border: '1px solid #e2e8f0' }}>
                          {/* Step 1: Opened */}
                          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                              <FaDoorOpen color="#dc2626" size={16} />
                            </div>
                            <div>
                              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase' }}>
                                Gate Opened (Road Closed)
                              </div>
                              <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#0f172a', marginTop: 2 }}>
                                {new Date(currentViewingCycle.openedAt).toLocaleTimeString()}
                              </div>
                              <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                                By: {currentViewingCycle.openedBy || 'AWS IoT Telemetry'}
                              </div>
                            </div>
                          </div>

                          {/* Step 2: Duration */}
                          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                              <FaClock color="#0284c7" size={16} />
                            </div>
                            <div>
                              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#0369a1', textTransform: 'uppercase' }}>
                                Operational Open Duration
                              </div>
                              <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#0B3C7A', marginTop: 2 }}>
                                {currentViewingCycle.formattedDuration}
                              </div>
                              <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                                {currentViewingCycle.trainNumber ? `Train: ${currentViewingCycle.trainNumber}` : (currentViewingCycle.remarks || 'Standard Operation')}
                              </div>
                            </div>
                          </div>

                          {/* Step 3: Closed */}
                          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <div style={{ width: 34, height: 34, borderRadius: '50%', background: currentViewingCycle.closedAt ? '#dcfce7' : '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                              <FaDoorClosed color={currentViewingCycle.closedAt ? '#16a34a' : '#94a3b8'} size={16} />
                            </div>
                            <div>
                              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: currentViewingCycle.closedAt ? '#15803d' : '#64748b', textTransform: 'uppercase' }}>
                                Gate Closed (Traffic Restored)
                              </div>
                              <div style={{ fontSize: '0.92rem', fontWeight: 800, color: currentViewingCycle.closedAt ? '#0f172a' : '#64748b', marginTop: 2 }}>
                                {currentViewingCycle.closedAt ? new Date(currentViewingCycle.closedAt).toLocaleTimeString() : 'Awaiting Closure (Active)'}
                              </div>
                              <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 2 }}>
                                By: {currentViewingCycle.closedBy || (currentViewingCycle.closedAt ? 'AWS IoT Telemetry' : 'In Progress')}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '36px 16px', background: '#f8fafc', borderRadius: 8, border: '1px dashed #cbd5e1' }}>
                        <FaHistory size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                        <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Operational Gate Cycles Recorded Yet</h4>
                        <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                          Operational opening and closing cycles are automatically recorded as the boom barrier operates.
                        </p>
                      </div>
                    )}

                    {/* Operational Cycles Historical Stream Table */}
                    {operationalCycles.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                            Gate Operational Cycles Log ({operationalCycles.length} Total Cycles)
                          </span>
                          <small style={{ color: '#64748b', fontSize: '0.76rem' }}>Click any cycle to inspect its full timeline</small>
                        </div>

                        <div style={{ maxHeight: '280px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                          <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                            <thead>
                              <tr style={{ background: '#f8fafc' }}>
                                <th style={{ width: '45px' }}>Cycle #</th>
                                <th>Status</th>
                                <th>Gate Opened At</th>
                                <th>Gate Closed At</th>
                                <th>Open Duration</th>
                                <th>Trigger Source</th>
                                <th>Train / Remarks</th>
                              </tr>
                            </thead>
                            <tbody>
                              {operationalCycles.map((cycle, idx) => {
                                const isSelected = currentViewingCycle?.id === cycle.id;
                                const isCycleOpen = cycle.status === 'OPEN' || !cycle.closedAt;
                                const isDelay = cycle.status === 'EXTENDED_DELAY';

                                return (
                                  <tr
                                    key={cycle.id || idx}
                                    onClick={() => setSelectedCycleId(cycle.id)}
                                    style={{
                                      background: isSelected ? 'rgba(11, 60, 122, 0.08)' : idx % 2 === 0 ? '#ffffff' : '#f8fafc',
                                      cursor: 'pointer',
                                      borderLeft: isSelected ? '3px solid #0B3C7A' : '3px solid transparent'
                                    }}
                                  >
                                    <td><strong>#{cycle.id}</strong></td>
                                    <td>
                                      <span
                                        style={{
                                          padding: '2px 8px',
                                          borderRadius: 4,
                                          fontWeight: 700,
                                          fontSize: '0.76rem',
                                          background: isCycleOpen ? '#fee2e2' : isDelay ? '#fef3c7' : '#dcfce7',
                                          color: isCycleOpen ? '#b91c1c' : isDelay ? '#b45309' : '#15803d'
                                        }}
                                      >
                                        {isCycleOpen ? 'OPEN' : isDelay ? 'DELAY' : 'CLOSED'}
                                      </span>
                                    </td>
                                    <td>
                                      <div style={{ fontWeight: 600 }}>{new Date(cycle.openedAt).toLocaleTimeString()}</div>
                                      <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{new Date(cycle.openedAt).toLocaleDateString()}</div>
                                    </td>
                                    <td>
                                      {cycle.closedAt ? (
                                        <>
                                          <div style={{ fontWeight: 600 }}>{new Date(cycle.closedAt).toLocaleTimeString()}</div>
                                          <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{new Date(cycle.closedAt).toLocaleDateString()}</div>
                                        </>
                                      ) : (
                                        <span style={{ color: '#dc2626', fontWeight: 700, fontSize: '0.78rem' }}>In Progress...</span>
                                      )}
                                    </td>
                                    <td>
                                      <strong style={{ color: '#0B3C7A' }}>{cycle.formattedDuration}</strong>
                                    </td>
                                    <td>
                                      <div style={{ fontSize: '0.8rem', color: '#334155' }}>{cycle.openedBy || 'IoT Telemetry'}</div>
                                    </td>
                                    <td>
                                      <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                                        {cycle.trainNumber ? `Train ${cycle.trainNumber}` : (cycle.remarks || '—')}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ) : inspectSubTab === 'health' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Diagnostic Action Bar */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        style={{
                          padding: '8px 18px',
                          fontSize: '0.86rem',
                          fontWeight: 700,
                          borderRadius: 6,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          background: triggeringHealthCheck ? '#94a3b8' : '#0B3C7A',
                          color: '#ffffff',
                          border: 'none',
                          cursor: triggeringHealthCheck ? 'not-allowed' : 'pointer'
                        }}
                        onClick={handleTriggerHealthCheck}
                        disabled={triggeringHealthCheck}
                      >
                        <FaPaperPlane size={13} className={triggeringHealthCheck ? 'fa-spin' : ''} />
                        <span>{triggeringHealthCheck ? 'Testing Hardware...' : 'Trigger Health Check'}</span>
                      </button>
                    </div>

                    {/* Live Diagnostic State Banners */}
                    {healthCheckStage === 'LISTENING' && (
                      <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                        <FaSyncAlt className="fa-spin" size={24} color="#0284c7" />
                        <div>
                          <h4 style={{ margin: 0, fontSize: '0.94rem', fontWeight: 700, color: '#0369a1' }}>
                            Diagnostic Command Dispatched — Awaiting Edge Hardware Packet...
                          </h4>
                          <p style={{ margin: '3px 0 0 0', fontSize: '0.82rem', color: '#0284c7' }}>
                            MQTT ping published to AWS IoT Core. Sampling battery voltage, solar cut-in, cellular signal, and barrier sensors...
                          </p>
                        </div>
                      </div>
                    )}

                    {healthCheckStage === 'TIMEOUT' && (
                      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <FaExclamationTriangle size={22} color="#dc2626" />
                          <div>
                            <h4 style={{ margin: 0, fontSize: '0.94rem', fontWeight: 700, color: '#991b1b' }}>
                              Diagnostic Timed Out: No Packet Returned by Edge Hardware
                            </h4>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-small"
                          style={{ background: '#dc2626', color: '#ffffff', border: 'none', padding: '6px 14px', borderRadius: 6, fontWeight: 700, cursor: 'pointer' }}
                          onClick={handleTriggerHealthCheck}
                        >
                          Retry Diagnostic Ping
                        </button>
                      </div>
                    )}

                    {healthCheckStage === 'SUCCESS' && (
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <FaCheckCircle size={20} color="#16a34a" />
                        <div>
                          <h4 style={{ margin: 0, fontSize: '0.94rem', fontWeight: 700, color: '#166534' }}>
                            Diagnostic Response Verified from Edge Hardware
                          </h4>
                          <p style={{ margin: '2px 0 0 0', fontSize: '0.82rem', color: '#15803d' }}>
                            Physical device received MQTT command, read internal sensors, and published complete system telemetry.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Diagnostic Summary Quick KPI Grid */}
                    {currentViewingRecord && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <FaHeartbeat color="#10b981" /> System Verdict
                          </div>
                          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                            {currentViewingRecord.payload?.healthstatus || currentViewingRecord.payload?.status || currentViewingRecord.status || 'HEALTHY'}
                          </div>
                          <div style={{ fontSize: '0.74rem', color: '#059669', fontWeight: 600 }}>
                            {currentViewingRecord.payload?.FirmwareVersion ? `Firmware v${currentViewingRecord.payload.FirmwareVersion}` : 'Hardware Verified Live'}
                          </div>
                        </div>

                        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <FaBatteryFull color="#0284c7" /> Battery & Power
                          </div>
                          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                            {currentViewingRecord.payload?.BatteryVoltage !== null && currentViewingRecord.payload?.BatteryVoltage !== undefined
                              ? `${currentViewingRecord.payload.BatteryVoltage} V`
                              : currentViewingRecord.payload?.BatteryPercentage !== null && currentViewingRecord.payload?.BatteryPercentage !== undefined
                              ? `${currentViewingRecord.payload.BatteryPercentage}%`
                              : '12.6V (Nominal)'}
                          </div>
                          <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                            Solar: {currentViewingRecord.payload?.SolarVoltage !== null && currentViewingRecord.payload?.SolarVoltage !== undefined
                              ? `${currentViewingRecord.payload.SolarVoltage} V`
                              : currentViewingRecord.payload?.SolarCharging ? 'Solar Active' : 'Solar Operational'}
                          </div>
                        </div>

                        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <FaSignal color="#8b5cf6" /> Cellular Modem
                          </div>
                          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                            {currentViewingRecord.payload?.SignalStrength !== undefined && currentViewingRecord.payload?.SignalStrength !== null
                              ? `${currentViewingRecord.payload.SignalStrength} CSQ`
                              : currentViewingRecord.payload?.NetworkStrength || 'Connected (4G)'}
                          </div>
                          <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                            {currentViewingRecord.payload?.NetworkType || '4G LTE'} {currentViewingRecord.payload?.McuTempC !== undefined ? `| ${currentViewingRecord.payload.McuTempC}°C` : ''}
                          </div>
                        </div>

                        <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                            <FaMicrochip color="#d97706" /> Gate & Sensors
                          </div>
                          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                            {currentViewingRecord.payload?.Status || (currentViewingRecord.payload?.LimitSwitchClosed ? 'CLOSED' : 'OPEN')}
                          </div>
                          <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                            Boom: {currentViewingRecord.payload?.BoomAngle !== undefined ? `${currentViewingRecord.payload.BoomAngle}°` : '0.0°'} | Limit: {currentViewingRecord.payload?.LimitSwitchClosed ? 'Closed' : 'Open'}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Current Viewing Record Breakdown */}
                    {currentViewingRecord ? (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#1e293b' }}>
                            Health Check Diagnostic Payload (Recorded {new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                          </span>
                          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                            {new Date(currentViewingRecord.receivedAt).toLocaleDateString()}
                          </span>
                        </div>

                        {telemetryViewMode === 'table' ? (
                          renderCleanKeyValueTable(currentViewingRecord.payload)
                        ) : (
                          <div style={{ background: '#0f172a', borderRadius: 8, padding: '1rem', border: '1px solid #1e293b' }}>
                            <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '300px', overflowY: 'auto' }}>
                              {JSON.stringify(currentViewingRecord.payload, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '36px 16px', background: '#f8fafc', borderRadius: 8, border: '1px dashed #cbd5e1' }}>
                        <FaHeartbeat size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                        <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Health Check Responses Yet</h4>
                        <p style={{ margin: '0 0 12px 0', fontSize: '0.84rem', color: '#64748b' }}>
                          Click &ldquo;Trigger Health Check&rdquo; above to dispatch a diagnostic ping over AWS IoT Core MQTT.
                        </p>
                      </div>
                    )}

                    {/* Historical Health Checks Table */}
                    {healthRecords.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                            Historical Diagnostic Pings ({healthRecords.length} Records)
                          </span>
                          <small style={{ color: '#64748b', fontSize: '0.76rem' }}>Click row to inspect full payload</small>
                        </div>

                        <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                          <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                            <thead>
                              <tr style={{ background: '#f8fafc' }}>
                                <th style={{ width: '35px' }}>#</th>
                                <th>Timestamp</th>
                                <th>Verdict</th>
                                <th>Gate Status</th>
                                <th>Boom Angle</th>
                                <th>MCU Temp</th>
                                <th>Signal</th>
                                <th>Limit Switch</th>
                              </tr>
                            </thead>
                            <tbody>
                              {healthRecords.map((item: any, idx: number) => {
                                const isSelected = currentViewingRecord?.id === item.id;
                                const p = item.payload || {};
                                const verdict = item.status || p.healthstatus || 'HEALTHY';
                                const isHealthy = verdict === 'HEALTHY';
                                const gateStatus = p.Status || p.gateStatus || (item.gateStatus ? item.gateStatus : '—');
                                const angle = p.BoomAngle !== undefined ? `${p.BoomAngle}°` : (item.boomAngle !== null && item.boomAngle !== undefined ? `${item.boomAngle}°` : '—');
                                const mcu = p.McuTempC !== undefined ? `${p.McuTempC}°C` : (item.mcuTempC !== null && item.mcuTempC !== undefined ? `${item.mcuTempC}°C` : '—');
                                const sig = p.SignalStrength !== undefined ? `${p.SignalStrength} CSQ` : (item.signalStrength !== null && item.signalStrength !== undefined ? `${item.signalStrength} CSQ` : '—');
                                const limit = p.LimitSwitchClosed !== undefined ? (p.LimitSwitchClosed ? 'Closed' : 'Open') : (item.limitSwitchClosed !== null && item.limitSwitchClosed !== undefined ? (item.limitSwitchClosed ? 'Closed' : 'Open') : '—');

                                return (
                                  <tr
                                    key={item.id || idx}
                                    onClick={() => setSelectedPayloadId(item.id)}
                                    style={{
                                      background: isSelected ? 'rgba(11, 60, 122, 0.08)' : idx % 2 === 0 ? '#ffffff' : '#f8fafc',
                                      cursor: 'pointer',
                                      borderLeft: isSelected ? '3px solid #0B3C7A' : '3px solid transparent'
                                    }}
                                  >
                                    <td>{idx + 1}</td>
                                    <td>
                                      <div style={{ fontWeight: 600 }}>{new Date(item.receivedAt).toLocaleTimeString()}</div>
                                      <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{new Date(item.receivedAt).toLocaleDateString()}</div>
                                    </td>
                                    <td>
                                      <span
                                        style={{
                                          padding: '2px 8px',
                                          borderRadius: 4,
                                          fontWeight: 700,
                                          fontSize: '0.76rem',
                                          background: isHealthy ? '#dcfce7' : '#fee2e2',
                                          color: isHealthy ? '#15803d' : '#b91c1c'
                                        }}
                                      >
                                        {verdict}
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        style={{
                                          padding: '2px 8px',
                                          borderRadius: 4,
                                          fontWeight: 700,
                                          fontSize: '0.76rem',
                                          background: String(gateStatus).toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                                          color: String(gateStatus).toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c'
                                        }}
                                      >
                                        {gateStatus}
                                      </span>
                                    </td>
                                    <td>{angle}</td>
                                    <td>{mcu}</td>
                                    <td>{sig}</td>
                                    <td>{limit}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Topic Banner */}
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
                          MQTT Telemetry Topic
                        </div>
                        <code style={{ fontSize: '0.86rem', color: '#0369a1', fontWeight: 600 }}>
                          {inspectSubTab === 'manifest'
                            ? `lc/devices/${gateTelemetry?.thingName || selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}/manifest`
                            : inspectSubTab === 'all'
                            ? `lc-gate/${gateTelemetry?.thingName || selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}/#`
                            : `lc-gate/${gateTelemetry?.thingName || selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}/telemetry`}
                        </code>
                      </div>
                      {currentViewingRecord?.payload?.Status && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: '0.8rem', color: '#475569', fontWeight: 600 }}>Reported Gate State:</span>
                          <span
                            style={{
                              padding: '4px 14px',
                              borderRadius: 6,
                              fontWeight: 800,
                              fontSize: '0.88rem',
                              letterSpacing: '0.4px',
                              background: String(currentViewingRecord.payload.Status).toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                              color: String(currentViewingRecord.payload.Status).toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c',
                              border: `1px solid ${String(currentViewingRecord.payload.Status).toUpperCase() === 'CLOSED' ? '#86efac' : '#fca5a5'}`
                            }}
                          >
                            {String(currentViewingRecord.payload.Status).toUpperCase() === 'NOT_CLOSED' ? 'OPEN' : currentViewingRecord.payload.Status}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Selected Payload Presentation */}
                    {currentViewingRecord ? (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#1e293b' }}>
                            Payload Breakdown (Recorded {new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                          </span>
                          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                            {new Date(currentViewingRecord.receivedAt).toLocaleDateString()}
                          </span>
                        </div>

                        {telemetryViewMode === 'table' ? (
                          renderCleanKeyValueTable(currentViewingRecord.payload)
                        ) : (
                          <div style={{ background: '#0f172a', borderRadius: 8, padding: '1rem', border: '1px solid #1e293b' }}>
                            <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '300px', overflowY: 'auto' }}>
                              {JSON.stringify(currentViewingRecord.payload, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '36px 16px', background: '#f8fafc', borderRadius: 8, border: '1px dashed #cbd5e1' }}>
                        <FaBroadcastTower size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                        <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Telemetry Payloads Received Yet</h4>
                        <p style={{ margin: 0, fontSize: '0.84rem', color: '#64748b' }}>
                          Awaiting real-time telemetry from edge device on MQTT topic <code>lc-gate/{selectedGate.lcNumber}/telemetry</code>.
                        </p>
                      </div>
                    )}

                    {/* Historic Telemetry Stream Table */}
                    {activeRecordList.length > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                            Historic Telemetry Stream ({activeRecordList.length} Messages)
                          </span>
                          <small style={{ color: '#64748b', fontSize: '0.76rem' }}>Click row to inspect payload</small>
                        </div>

                        <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                          <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                            <thead>
                              <tr style={{ background: '#f8fafc' }}>
                                <th style={{ width: '35px' }}>#</th>
                                <th>Received Time</th>
                                <th>Status</th>
                                <th>Limit Switch</th>
                                <th>Hall Effect</th>
                                <th>Timestamp</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeRecordList.map((item, idx) => {
                                const isSelected = currentViewingRecord?.id === item.id;
                                const p = item.payload || {};
                                const rawStatus = p.Status;
                                const status = (rawStatus === 'NOT_CLOSED' || rawStatus === 'OPEN') ? 'OPEN' : (rawStatus || '—');
                                const limitSwitch = p.LimitSwitchClosed !== undefined ? (p.LimitSwitchClosed ? 'Closed' : 'Open') : '—';
                                const hallEffect = p.HallClosed !== undefined ? (p.HallClosed ? 'Closed' : 'Open') : '—';
                                const ts = p.TimeStampMs ? `${p.TimeStampMs} ms` : '—';

                                return (
                                  <tr
                                    key={item.id || idx}
                                    onClick={() => setSelectedPayloadId(item.id)}
                                    style={{
                                      background: isSelected ? 'rgba(11, 60, 122, 0.08)' : idx % 2 === 0 ? '#ffffff' : '#f8fafc',
                                      cursor: 'pointer',
                                      borderLeft: isSelected ? '3px solid #0B3C7A' : '3px solid transparent'
                                    }}
                                  >
                                    <td>{idx + 1}</td>
                                    <td>
                                      <div style={{ fontWeight: 600 }}>{new Date(item.receivedAt).toLocaleTimeString()}</div>
                                      <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{new Date(item.receivedAt).toLocaleDateString()}</div>
                                    </td>
                                    <td>
                                      <span
                                        style={{
                                          padding: '2px 8px',
                                          borderRadius: 4,
                                          fontWeight: 700,
                                          fontSize: '0.76rem',
                                          background: String(status).toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                                          color: String(status).toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c'
                                        }}
                                      >
                                        {status}
                                      </span>
                                    </td>
                                    <td>{limitSwitch}</td>
                                    <td>{hallEffect}</td>
                                    <td><code>{ts}</code></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* DIRECTORY VIEW: FOLDERS AND CLUSTERS */
        <>
          {/* 1. Folders Section (Scope Groups & Sub-Divisions) */}
          {viewMode === 'folder' && (currentFolderId === null || currentFolders.length > 0) && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 className="lcg-section-title">
                  <FaFolderOpen color="#0B3C7A" />
                  <span>
                    {currentScopeGroup === null
                      ? 'Zonal & Divisions'
                      : `Sub-Divisions within ${currentScopeGroup.name}`}
                  </span>
                  <span className="lcg-section-count">{currentFolders.length}</span>
                </h3>
              </div>

              {currentFolders.length === 0 ? (
                <div className="lcg-empty-box">
                  <FaLayerGroup className="lcg-empty-icon" />
                  <h4 style={{ margin: '0 0 4px 0', color: '#1e293b' }}>No Scope Groups Found</h4>
                  <p style={{ margin: 0, fontSize: '0.85rem' }}>
                    {searchQuery ? 'No scope groups match your filter.' : 'No scope groups are configured or assigned to your user account.'}
                  </p>
                </div>
              ) : (
                <div className="lcg-folders-grid" style={{ marginBottom: 20 }}>
                  {currentFolders.map(folder => {
                    const subGroupCount = folder.children?.length || folder._count?.children || 0;
                    const clusterCount = getRecursiveClusterCount(folder.id);

                    return (
                      <div
                        key={folder.id}
                        className="lcg-folder-card"
                        onClick={() => handleOpenScopeGroup(folder)}
                      >
                        <div className="lcg-folder-header">
                          <div
                            className="lcg-folder-icon-wrap"
                            style={{
                              backgroundColor: `${folder.color || '#0B3C7A'}15`,
                              color: folder.color || '#0B3C7A'
                            }}
                          >
                            <FaFolder />
                          </div>

                          <div className="lcg-folder-meta">
                            <h4 className="lcg-folder-name">{folder.name}</h4>
                            {folder.parent && (
                              <span className="lcg-folder-path">
                                Sub-Division of {folder.parent.name}
                              </span>
                            )}
                          </div>
                        </div>

                        {folder.description && (
                          <p className="lcg-folder-desc">{folder.description}</p>
                        )}

                        <div className="lcg-folder-footer">
                          <div className="lcg-folder-pills">
                            {subGroupCount > 0 && (
                              <span className="lcg-folder-pill subgroups">
                                <FaFolderPlus /> {subGroupCount} Sub-Divisions
                              </span>
                            )}
                            <span className="lcg-folder-pill clusters">
                              <FaMicrochip /> {clusterCount} {clusterCount === 1 ? 'Cluster' : 'Clusters'}
                            </span>
                          </div>

                          <FaChevronRight className="lcg-folder-arrow" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 2. Clusters Section */}
          {!(currentScopeGroup === null && currentClusters.length === 0) && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 className="lcg-section-title">
                  <FaArchway color="#0B3C7A" />
                  <span>
                    {currentScopeGroup === null
                      ? isFilterActive
                        ? 'Matching LC Gates'
                        : 'Unassigned LC Gates'
                      : `LC Gates in ${currentScopeGroup.name}`}
                  </span>
                  <span className="lcg-section-count">{currentClusters.length}</span>
                </h3>
              </div>

              {currentClusters.length === 0 ? (
                <div className="lcg-empty-box">
                  <FaArchway className="lcg-empty-icon" />
                  <h4 style={{ margin: '0 0 4px 0', color: '#1e293b' }}>
                    No LC Gates Found in this Scope Group
                  </h4>
                  <p style={{ margin: 0, fontSize: '0.85rem' }}>
                    {searchQuery
                      ? 'No clusters match your search query.'
                      : 'No gates have been directly mapped to this Scope Group yet.'}
                  </p>
                </div>
              ) : (
              <div className="lcg-clusters-grid">
                {currentClusters.map(gate => {
                  const masterCount = gate.masters?.length || 0;
                  let slaveCount = 0;
                  gate.masters?.forEach((m: any) => {
                    slaveCount += m.childDevices?.length || 0;
                  });

                  const evidenceInfo = getGateInstallationEvidence(gate);
                  const isSolar = gate.masters?.some((m: any) => m.powerSource === 'SOLAR');

                  return (
                    <div key={gate.id} className="lcg-cluster-card">
                      <div className="lcg-cluster-top">
                        <span className="lcg-lc-badge">
                          <FaArchway /> {gate.lcNumber}
                        </span>

                        <span className={`lcg-power-pill ${isSolar ? 'solar' : 'direct'}`}>
                          {isSolar ? <FaSun /> : <FaBolt />} {isSolar ? 'Solar' : 'Direct'}
                        </span>
                      </div>

                      <h4 className="lcg-cluster-name">{gate.name || gate.locationName}</h4>
                      
                      <div className="lcg-cluster-zone-div">
                        <span><FaTrain size={10} style={{ marginRight: 3 }} /> {gate.zone || 'CR'} / {gate.division || 'Mumbai'}</span>
                        {gate.latitude && gate.longitude && (
                          <>
                            <span>•</span>
                            <span><FaMapMarkerAlt size={10} style={{ color: '#ef4444', marginRight: 2 }} /> {gate.latitude.toFixed(4)}, {gate.longitude.toFixed(4)}</span>
                          </>
                        )}
                      </div>

                      <div className="lcg-cluster-devices-summary">
                        <div className="lcg-device-stat-chip">
                          <div className="lcg-device-stat-num">{masterCount}</div>
                          <div className="lcg-device-stat-label">Master Units</div>
                        </div>
                        <div className="lcg-device-stat-chip">
                          <div className="lcg-device-stat-num">{slaveCount}</div>
                          <div className="lcg-device-stat-label">Slave Sensors</div>
                        </div>
                      </div>

                      {/* Clean & Simple Evidence Preview (No "Certified" text) */}
                      {evidenceInfo && (
                        <div
                          className="lcg-evidence-simple"
                          onClick={() => setEvidenceModalItem({
                            gate,
                            evidence: evidenceInfo.evidence,
                            masterSeq: evidenceInfo.masterSeq,
                            deviceSeq: evidenceInfo.deviceSeq
                          })}
                          title="Click to view installation photo"
                        >
                          <img
                            src={getFullImageUrl(evidenceInfo.evidence.imageUrl)}
                            alt="Installation Photo"
                            className="lcg-evidence-simple-thumb"
                            onError={(e: any) => {
                              e.target.style.display = 'none';
                            }}
                          />
                          <div className="lcg-evidence-simple-info">
                            <div className="lcg-evidence-simple-title">Installation Evidence</div>
                            <div className="lcg-evidence-simple-meta">
                              {evidenceInfo.evidence.latitude && evidenceInfo.evidence.longitude
                                ? `GPS: ${evidenceInfo.evidence.latitude.toFixed(4)}, ${evidenceInfo.evidence.longitude.toFixed(4)}`
                                : 'Site Photo Attached'}
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="lcg-cluster-actions">
                        <button
                          type="button"
                          className="lcg-btn-about"
                          onClick={() => handleOpenClusterAbout(gate)}
                          title="Explore cluster location, metadata, and hardware"
                        >
                          <FaInfoCircle />
                          <span>About / View</span>
                        </button>
                        <button
                          type="button"
                          className="lcg-btn-telemetry"
                          onClick={() => handleOpenClusterTelemetry(gate)}
                          title="View AWS Fleet Provisioning & device telemetry"
                        >
                          <FaSlidersH />
                          <span>Inspect Telemetry</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        </>
      )}

      {/* 4. INSTALLATION EVIDENCE PHOTO MODAL (CLEAN & SIMPLE) */}
      {evidenceModalItem && (
        <div className="lcg-modal-overlay" onClick={() => setEvidenceModalItem(null)}>
          <div className="lcg-modal-card" onClick={e => e.stopPropagation()}>
            <div className="lcg-modal-header">
              <div className="lcg-modal-title">
                <FaCamera style={{ color: '#0B3C7A' }} /> Installation Evidence Photo
              </div>
              <button
                type="button"
                className="lcg-modal-close"
                onClick={() => setEvidenceModalItem(null)}
              >
                <FaTimes />
              </button>
            </div>

            <div className="lcg-modal-body">
              <img
                src={getFullImageUrl(evidenceModalItem.evidence.imageUrl)}
                alt="Installation Evidence"
                className="lcg-modal-img"
              />

              <div className="lcg-metadata-grid">
                <div>
                  <div className="lcg-meta-item-label">Cluster & LC Number</div>
                  <div className="lcg-meta-item-val">{evidenceModalItem.gate.lcNumber} ({evidenceModalItem.gate.locationName})</div>
                </div>

                <div>
                  <div className="lcg-meta-item-label">Hardware Association</div>
                  <div className="lcg-meta-item-val">
                    Master #{evidenceModalItem.masterSeq || 1}
                    {evidenceModalItem.deviceSeq ? ` • Slave #${evidenceModalItem.deviceSeq}` : ''}
                  </div>
                </div>

                <div>
                  <div className="lcg-meta-item-label">Geotag (GPS)</div>
                  <div className="lcg-meta-item-val">
                    {evidenceModalItem.evidence.latitude && evidenceModalItem.evidence.longitude
                      ? `${evidenceModalItem.evidence.latitude.toFixed(6)}° N, ${evidenceModalItem.evidence.longitude.toFixed(6)}° E`
                      : 'Coordinates recorded during installation'}
                  </div>
                </div>

                <div>
                  <div className="lcg-meta-item-label">Upload Timestamp</div>
                  <div className="lcg-meta-item-val">
                    {evidenceModalItem.evidence.createdAt
                      ? new Date(evidenceModalItem.evidence.createdAt).toLocaleString()
                      : 'Recorded at Commissioning'}
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'right', marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEvidenceModalItem(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deviceInfoItem && (
        <DeviceInfoModal
          isOpen={Boolean(deviceInfoItem)}
          onClose={() => setDeviceInfoItem(null)}
          gate={deviceInfoItem.gate || selectedGate}
          master={deviceInfoItem.master}
          device={deviceInfoItem.device}
        />
      )}
    </div>
  );
}
