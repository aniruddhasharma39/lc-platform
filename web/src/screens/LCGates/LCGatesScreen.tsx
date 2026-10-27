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
  FaFileAlt
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
                        background: strVal.toUpperCase() === 'CLOSED' ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                        color: strVal.toUpperCase() === 'CLOSED' ? '#047857' : '#b91c1c',
                        border: `1px solid ${strVal.toUpperCase() === 'CLOSED' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
                      }}
                    >
                      {strVal}
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

export default function LCGatesScreen({ user }: Props) {
  const isDeveloper = user.role === 'Developer';

  // Navigation State
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: number | null; name: string; color?: string | null }>>([
    { id: null, name: 'Root Directory' }
  ]);
  const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;

  // View Mode: 'folder' (Folder Explorer) or 'flat' (All Clusters) or 'detail' (Cluster Drilldown)
  const [viewMode, setViewMode] = useState<'folder' | 'flat' | 'detail'>('folder');

  // Selected Cluster for Full Drilldown
  const [selectedGate, setSelectedGate] = useState<any | null>(null);

  // Drilldown Active Tab: 'about' | 'deviceInfo' | 'telemetry'
  const [clusterTab, setClusterTab] = useState<'about' | 'deviceInfo' | 'telemetry'>('about');
  const [deviceInfoItem, setDeviceInfoItem] = useState<any | null>(null);

  const { success: toastSuccess, error: toastError } = useToast();

  // Telemetry Inspector state for the selected gate
  const [gateTelemetry, setGateTelemetry] = useState<any | null>(null);
  const [loadingTelemetry, setLoadingTelemetry] = useState<boolean>(false);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [selectedPayloadId, setSelectedPayloadId] = useState<number | null>(null);
  const [inspectSubTab, setInspectSubTab] = useState<'telemetry' | 'manifest' | 'health' | 'all'>('telemetry');
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
  const [searchQuery, setSearchQuery] = useState('');

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

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(g =>
        g.name.toLowerCase().includes(q) ||
        (g.description && g.description.toLowerCase().includes(q))
      );
    }

    return result;
  }, [scopeGroups, currentFolderId, searchQuery]);

  // Clusters directly in current directory or flat view
  const currentClusters = useMemo(() => {
    if (viewMode === 'flat') {
      if (!searchQuery.trim()) return gates;
      const q = searchQuery.toLowerCase().trim();
      return gates.filter(g =>
        g.lcNumber.toLowerCase().includes(q) ||
        (g.name && g.name.toLowerCase().includes(q)) ||
        (g.locationName && g.locationName.toLowerCase().includes(q)) ||
        (g.zone && g.zone.toLowerCase().includes(q)) ||
        (g.division && g.division.toLowerCase().includes(q))
      );
    }

    if (currentFolderId === null) {
      return [];
    }

    let result = gates.filter(g =>
      g.scopeGroups?.some((sg: any) => (sg.scopeGroupId || sg.scopeGroup?.id) === currentFolderId)
    );

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(g =>
        g.lcNumber.toLowerCase().includes(q) ||
        (g.name && g.name.toLowerCase().includes(q)) ||
        (g.locationName && g.locationName.toLowerCase().includes(q))
      );
    }

    return result;
  }, [gates, currentFolderId, viewMode, searchQuery]);

  const totalAccessibleClusters = gates.length;
  const totalAccessibleFolders = scopeGroups.length;

  // Folder Click Handler
  const handleOpenFolder = (group: ScopeGroupItem) => {
    setBreadcrumbs(prev => [
      ...prev,
      { id: group.id, name: group.name, color: group.color }
    ]);
  };

  // Breadcrumb Jump Handler
  const handleJumpBreadcrumb = (index: number) => {
    setBreadcrumbs(prev => prev.slice(0, index + 1));
    setViewMode('folder');
    setSelectedGate(null);
  };

  // Open cluster drilldown in "About / View" mode
  const handleOpenClusterAbout = (gate: any) => {
    setSelectedGate(gate);
    setClusterTab('about');
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

  // Trigger health check command to physical gate hardware
  const handleTriggerGatePing = async () => {
    if (!selectedGate) return;
    setTriggeringHealthCheck(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgate/${selectedGate.id}/health-check`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (res.ok) {
        toastSuccess(data.message || 'Health check command published over MQTT', 'Health Check Sent');
        await fetchGateTelemetry(selectedGate.id, true);
        setInspectSubTab('health');
      } else {
        toastError(data.error || 'Failed to ping gate', 'Health Check');
      }
    } catch (err: any) {
      toastError(err.message || 'Error triggering health check', 'Health Check');
    } finally {
      setTriggeringHealthCheck(false);
    }
  };

  const allHistoricPayloads: any[] = useMemo(() => gateTelemetry?.payloads || [], [gateTelemetry]);
  const telemetryRecords: any[] = useMemo(() => gateTelemetry?.telemetryRecords || [], [gateTelemetry]);
  const manifestRecords: any[] = useMemo(() => gateTelemetry?.manifestRecords || [], [gateTelemetry]);
  const healthRecords: any[] = useMemo(() => gateTelemetry?.healthRecords || [], [gateTelemetry]);

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
    }
    if (activeRecordList.length > 0) return activeRecordList[0];
    if (inspectSubTab === 'manifest' && gateTelemetry?.latestManifest) {
      return gateTelemetry.latestManifest;
    }
    if (inspectSubTab === 'health' && gateTelemetry?.latestHealthCheck) {
      return gateTelemetry.latestHealthCheck;
    }
    return gateTelemetry?.latestTelemetry || null;
  }, [selectedPayloadId, allHistoricPayloads, activeRecordList, inspectSubTab, gateTelemetry]);

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

  // Total hardware devices count for selected gate
  const totalDevicesCount = useMemo(() => {
    if (!selectedGate) return 0;
    const mastersCount = selectedGate.masters?.length || 0;
    const slavesCount = selectedGate.masters?.reduce(
      (acc: number, m: any) => acc + (m.childDevices?.length || 0),
      0
    ) || 0;
    return mastersCount + slavesCount;
  }, [selectedGate]);

  return (
    <div className="lcg-container">
      {/* 1. CLEAN & LIGHTWEIGHT HEADER */}
      <div className="lcg-header-light">
        <div className="lcg-header-info">
          <div className="lcg-header-title">
            <FaArchway />
            <span>LC Gates & Clusters Directory</span>
          </div>
          <p className="lcg-header-desc">
            Organized hierarchy of railway clusters and gates based on your designated Zonal and Division Scope Groups.
          </p>
        </div>

        <div className="lcg-header-chips">
          <div className="lcg-header-stat">
            <FaFolder color="#0B3C7A" />
            <span>Scope Groups: <strong>{totalAccessibleFolders}</strong></span>
          </div>
          <div className="lcg-header-stat">
            <FaMicrochip color="#0B3C7A" />
            <span>Clusters: <strong>{totalAccessibleClusters}</strong></span>
          </div>
          <div className="lcg-role-pill">
            {isDeveloper ? 'Developer Full Access' : `Role: ${user.role || 'Scoped Operator'}`}
          </div>
        </div>
      </div>

      {/* 2. NAVIGATION & TOOLBAR (SINGLE ROW ALIGNED) */}
      <div className="lcg-nav-toolbar">
        <div className="lcg-breadcrumbs">
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <React.Fragment key={crumb.id ?? 'root'}>
                <span
                  className={`lcg-crumb-item ${isLast && viewMode !== 'detail' ? 'active' : ''}`}
                  onClick={() => handleJumpBreadcrumb(idx)}
                  title={`Navigate to ${crumb.name}`}
                >
                  {idx === 0 ? <FaFolder size={12} /> : <FaFolderOpen size={12} color={crumb.color || '#0B3C7A'} />}
                  <span>{crumb.name}</span>
                </span>
                {(!isLast || viewMode === 'detail') && (
                  <span className="lcg-crumb-separator">/</span>
                )}
              </React.Fragment>
            );
          })}

          {viewMode === 'detail' && selectedGate && (
            <span className="lcg-crumb-item active">
              <FaArchway size={11} color="#0B3C7A" />
              <span>{selectedGate.lcNumber}</span>
            </span>
          )}
        </div>

        <div className="lcg-toolbar-right">
          <div className="lcg-search-input-wrap">
            <FaSearch className="lcg-search-icon" />
            <input
              type="text"
              className="lcg-search-input"
              placeholder="Search folders or gates..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="lcg-view-toggle">
            <button
              type="button"
              className={`lcg-toggle-btn ${viewMode === 'folder' ? 'active' : ''}`}
              onClick={() => { setViewMode('folder'); setSelectedGate(null); }}
              title="Folder Explorer View"
            >
              <FaFolder size={12} /> Folder Explorer
            </button>
            <button
              type="button"
              className={`lcg-toggle-btn ${viewMode === 'flat' ? 'active' : ''}`}
              onClick={() => { setViewMode('flat'); setSelectedGate(null); }}
              title="Flat Cluster Grid"
            >
              <FaArchway size={12} /> All Clusters
            </button>
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm lcg-refresh-btn"
            onClick={fetchData}
            title="Refresh directory"
          >
            <FaSyncAlt /> Refresh
          </button>
        </div>
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
          {/* Detail Top Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setViewMode('folder'); setSelectedGate(null); }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
            >
              <FaArrowLeft /> Back to Directory
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="lcg-power-pill direct" style={{ fontSize: '0.8rem' }}>
                <FaArchway /> Cluster {selectedGate.lcNumber}
              </span>
              <span className={`lcg-power-pill ${selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? 'solar' : 'direct'}`} style={{ fontSize: '0.8rem' }}>
                {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? <FaSun /> : <FaBolt />}
                {selectedGate.masters?.some((m: any) => m.powerSource === 'SOLAR') ? ' Solar Powered' : ' Direct AC'}
              </span>
            </div>
          </div>

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
              className={`lcg-tab-button ${clusterTab === 'about' ? 'active' : ''}`}
              onClick={() => setClusterTab('about')}
            >
              <FaInfoCircle size={14} />
              <span>About Cluster & Hardware</span>
            </button>
            <button
              type="button"
              className={`lcg-tab-button ${clusterTab === 'deviceInfo' ? 'active' : ''}`}
              onClick={() => setClusterTab('deviceInfo')}
            >
              <FaMicrochip size={14} />
              <span>Device Info & Manifest</span>
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
          {clusterTab === 'about' ? (
            /* ================= ABOUT CLUSTER & HARDWARE VIEW ================= */
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

                {/* Installation Evidence Preview Card */}
                <div className="lcg-about-card">
                  <div className="lcg-about-card-title">
                    <FaCamera color="#0B3C7A" />
                    <span>Installation Evidence</span>
                  </div>
                  {(() => {
                    const evidenceInfo = getGateInstallationEvidence(selectedGate);
                    if (evidenceInfo) {
                      return (
                        <div>
                          <div
                            className="lcg-evidence-simple"
                            style={{ cursor: 'pointer', marginBottom: 10 }}
                            onClick={() => setEvidenceModalItem({
                              gate: selectedGate,
                              evidence: evidenceInfo.evidence,
                              masterSeq: evidenceInfo.masterSeq,
                              deviceSeq: evidenceInfo.deviceSeq
                            })}
                            title="Click to view full photo"
                          >
                            <img
                              src={getFullImageUrl(evidenceInfo.evidence.imageUrl)}
                              alt="Evidence"
                              className="lcg-evidence-simple-thumb"
                              style={{ width: 50, height: 50 }}
                            />
                            <div className="lcg-evidence-simple-info">
                              <div className="lcg-evidence-simple-title">Equipment Photo</div>
                              <div className="lcg-evidence-simple-meta">
                                {evidenceInfo.evidence.latitude && evidenceInfo.evidence.longitude
                                  ? `GPS: ${evidenceInfo.evidence.latitude.toFixed(4)}, ${evidenceInfo.evidence.longitude.toFixed(4)}`
                                  : 'Site Photo Attached'}
                              </div>
                              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                                Master #{evidenceInfo.masterSeq || 1}{evidenceInfo.deviceSeq ? ` • Slave #${evidenceInfo.deviceSeq}` : ''}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center', gap: 6 }}
                            onClick={() => setEvidenceModalItem({
                              gate: selectedGate,
                              evidence: evidenceInfo.evidence,
                              masterSeq: evidenceInfo.masterSeq,
                              deviceSeq: evidenceInfo.deviceSeq
                            })}
                          >
                            <FaEye /> View Full Photo
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div style={{ background: '#f8fafc', padding: 14, borderRadius: 8, border: '1px solid #e2e8f0', color: '#64748b', fontSize: '0.82rem', textAlign: 'center' }}>
                        No installation evidence photo uploaded for this cluster yet.
                      </div>
                    );
                  })()}
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
                      const masterEvidence = master.evidences?.[0];
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
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
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

                              {/* Direct Photo Thumbnail Preview for Master */}
                              {masterEvidence && (
                                <div
                                  className="lcg-thumb-preview-wrap"
                                  onClick={() => setEvidenceModalItem({ gate: selectedGate, evidence: masterEvidence, masterSeq: master.masterSequence })}
                                  title="Click to view installation photo"
                                >
                                  <img
                                    src={getFullImageUrl(masterEvidence.imageUrl)}
                                    alt="Master Evidence"
                                    className="lcg-device-thumb-img"
                                  />
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Slave Devices */}
                          <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 8, border: '1px solid #f1f5f9' }}>
                            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                              <FaPlug color="#0284c7" /> Connected Slave Devices ({master.childDevices?.length || 0})
                            </div>

                            {(!master.childDevices || master.childDevices.length === 0) ? (
                              <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>No slave devices linked to this master.</span>
                            ) : (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
                                {master.childDevices.map((child: any) => {
                                  const childEvidence = child.evidences?.[0];
                                  return (
                                    <div
                                      key={child.id}
                                      style={{
                                        background: '#ffffff',
                                        border: '1px solid #e2e8f0',
                                        borderRadius: 8,
                                        padding: '7px 10px',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
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

                                      {/* Direct Photo Thumbnail Preview for Slave */}
                                      {childEvidence && (
                                        <div
                                          className="lcg-thumb-preview-wrap small"
                                          onClick={() => setEvidenceModalItem({
                                            gate: selectedGate,
                                            evidence: childEvidence,
                                            masterSeq: master.masterSequence,
                                            deviceSeq: child.deviceSequence
                                          })}
                                          title="Click to view installation photo"
                                        >
                                          <img
                                            src={getFullImageUrl(childEvidence.imageUrl)}
                                            alt="Slave Evidence"
                                            className="lcg-device-thumb-img"
                                          />
                                        </div>
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
          ) : clusterTab === 'deviceInfo' ? (
            /* ================= DEVICE INFO & MANIFEST VIEW ================= */
            <div className="lcg-device-info-tab-view">
              {/* Header Card */}
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '18px 22px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 10, background: '#e0f2fe', color: '#0369a1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem' }}>
                      <FaMicrochip />
                    </div>
                    <div>
                      <h3 style={{ margin: 0, fontSize: '1.18rem', fontWeight: 800, color: '#0f172a' }}>
                        Physical Device Manifest & Telemetry Profile
                      </h3>
                      <p style={{ margin: '3px 0 0', fontSize: '0.82rem', color: '#64748b' }}>
                        Hardware specifications and sensor mappings ingested from the edge device manifest payload.
                      </p>
                    </div>
                  </div>
                  <button 
                    type="button" 
                    className="btn btn-primary btn-sm"
                    onClick={() => setDeviceInfoItem({ gate: selectedGate, master: selectedGate.masters?.[0] })}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px' }}
                  >
                    <FaCode /> View Raw Manifest JSON
                  </button>
                </div>
              </div>

              {/* Master Unit Hardware Card */}
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px', marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <FaShieldAlt style={{ color: '#0b3c7a' }} />
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#0f172a' }}>
                    Master Gateway Controller ({selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber})
                  </h4>
                  <span className="badge badge-active" style={{ fontSize: '0.72rem' }}>Physical Cloud Thing</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Serial Number</span>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--primary)' }}>
                      {selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Device Name</span>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a' }}>
                      {selectedGate.deviceRegistries?.[0]?.attributes?.deviceName || 'LC Gate'}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Manufacturing Date</span>
                    <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#0f172a' }}>
                      {selectedGate.deviceRegistries?.[0]?.dateOfMfg ? new Date(selectedGate.deviceRegistries[0].dateOfMfg).toLocaleDateString() : (selectedGate.createdAt ? new Date(selectedGate.createdAt).toLocaleDateString() : 'N/A')}
                    </div>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Firmware Version</span>
                    <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#0f172a' }}>
                      v{selectedGate.deviceRegistries?.[0]?.firmwareVersion || '1.1'}
                    </div>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Description</span>
                    <div style={{ fontSize: '0.88rem', color: '#334155', marginTop: 2 }}>
                      {selectedGate.deviceRegistries?.[0]?.attributes?.description || 'Installed on IR Level Crossings'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Connected Wired Slaves Card (Dynamic from Database) */}
              <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <FaPlug style={{ color: '#0284c7' }} />
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 800, color: '#0f172a' }}>
                    Connected Physical Slave Units & Boom Sensors ({selectedGate.masters?.flatMap((m: any) => m.childDevices || []).length || 0})
                  </h4>
                </div>
                <p style={{ margin: '0 0 14px 0', fontSize: '0.82rem', color: '#64748b' }}>
                  Hardware devices hardwired to Master Gateway <strong>{selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}</strong>.
                </p>

                {(() => {
                  const allSlaves = selectedGate.masters?.flatMap((m: any) =>
                    (m.childDevices || []).map((c: any) => ({
                      ...c,
                      masterSeq: m.masterSequence,
                      masterSerial: m.serialNumber,
                      masterPower: m.powerSource
                    }))
                  ) || [];

                  if (allSlaves.length === 0) {
                    return (
                      <div style={{ background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 10, padding: '24px', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                        No slave hardware units or boom sensors have been configured for this master gateway yet.
                      </div>
                    );
                  }

                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
                      {allSlaves.map((slave: any) => (
                        <div key={slave.id} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <div>
                              <strong style={{ fontSize: '0.92rem', color: '#0f172a' }}>{slave.serialNumber}</strong>
                              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                                Sequence #{slave.deviceSequence} • Master: {slave.masterSerial}
                              </div>
                            </div>
                            <span style={{ fontSize: '0.72rem', background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>
                              {slave.type || 'SLAVE UNIT'} • Wired
                            </span>
                          </div>

                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Installed Unit Details:</span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                            <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', padding: '6px 10px', borderRadius: 6, fontSize: '0.8rem' }}>
                              <strong>Device Unit Type</strong>
                              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>{slave.type || 'Sensor / Barrier Unit'}</div>
                            </div>
                            <div style={{ background: '#ffffff', border: '1px solid #cbd5e1', padding: '6px 10px', borderRadius: 6, fontSize: '0.8rem' }}>
                              <strong>Master Parent Gateway</strong>
                              <div style={{ fontSize: '0.72rem', color: '#64748b' }}>Sequence #{slave.masterSeq} ({slave.masterSerial})</div>
                            </div>
                          </div>

                          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              style={{ padding: '4px 10px', fontSize: '0.72rem', borderRadius: 5, display: 'flex', alignItems: 'center', gap: 4 }}
                              onClick={() => setDeviceInfoItem({ device: slave, gate: selectedGate })}
                            >
                              <FaMicrochip /> Device Info
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
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
                    <span style={{ fontSize: '0.84rem', fontWeight: 600, color: '#475569' }}>
                      Cluster {selectedGate.lcNumber} • {selectedGate.locationName || selectedGate.name}
                    </span>
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
                  <div style={{ marginTop: 4, fontSize: '0.82rem', color: '#64748b' }}>
                    Real-time operational telemetry streamed via MQTT from edge gateway controller.
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

                  {/* Ping Device / Trigger Health Check */}
                  <button
                    type="button"
                    className="btn-small"
                    style={{
                      fontSize: '0.8rem',
                      padding: '7px 15px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      borderRadius: 6,
                      background: '#dc2626',
                      color: '#ffffff',
                      border: 'none',
                      fontWeight: 700,
                      cursor: triggeringHealthCheck ? 'not-allowed' : 'pointer',
                      boxShadow: '0 1px 3px rgba(220, 38, 38, 0.25)',
                    }}
                    onClick={handleTriggerGatePing}
                    disabled={triggeringHealthCheck}
                    title="Publish instant MQTT health ping to AWS IoT Core"
                  >
                    <FaHeartbeat className={triggeringHealthCheck ? 'fa-spin' : ''} size={13} color="#ffffff" />
                    <span>{triggeringHealthCheck ? 'Pinging Device...' : 'Ping Device'}</span>
                  </button>
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
                      {manifestRecords.length || totalDevicesCount || (selectedGate.masters?.length ? 1 : 0)}
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
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Topic Banner */}
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
                          MQTT Telemetry Topic
                        </div>
                        <code style={{ fontSize: '0.86rem', color: '#0369a1', fontWeight: 600 }}>
                          lc-gate/{gateTelemetry?.thingName || selectedGate.masters?.[0]?.serialNumber || selectedGate.lcNumber}/telemetry
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
                            {currentViewingRecord.payload.Status}
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
                                const status = p.Status || '—';
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
          {/* 1. Folders Section (Scope Groups) */}
          {viewMode === 'folder' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 className="lcg-section-title">
                  <FaFolderOpen color="#0B3C7A" />
                  <span>
                    {currentFolderId === null
                      ? 'Scope Groups (Zonal & Divisional)'
                      : `Sub-Divisions within ${breadcrumbs[breadcrumbs.length - 1].name}`}
                  </span>
                  <span className="lcg-section-count">{currentFolders.length}</span>
                </h3>

                {currentFolderId !== null && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleJumpBreadcrumb(breadcrumbs.length - 2)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}
                  >
                    <FaArrowLeft size={10} /> Up One Level
                  </button>
                )}
              </div>

              {currentFolders.length === 0 ? (
                currentFolderId === null ? (
                  <div className="lcg-empty-box">
                    <FaLayerGroup className="lcg-empty-icon" />
                    <h4 style={{ margin: '0 0 4px 0', color: '#1e293b' }}>No Scope Groups Found</h4>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      {searchQuery ? 'No scope groups match your filter.' : 'No scope groups are configured or assigned to your user account.'}
                    </p>
                  </div>
                ) : (
                  <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 8, border: '1px solid #e2e8f0', color: '#64748b', fontSize: '0.82rem', marginBottom: 14 }}>
                    This scope group has no sub-divisions. All assigned clusters are listed below.
                  </div>
                )
              ) : (
                <div className="lcg-folders-grid" style={{ marginBottom: 20 }}>
                  {currentFolders.map(folder => {
                    const subGroupCount = folder.children?.length || folder._count?.children || 0;
                    const clusterCount = getRecursiveClusterCount(folder.id);

                    return (
                      <div
                        key={folder.id}
                        className="lcg-folder-card"
                        onClick={() => handleOpenFolder(folder)}
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
                            <span className="lcg-folder-path">
                              {folder.parent ? `${folder.parent.name} / ${folder.name}` : `/${folder.name}`}
                            </span>
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
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 className="lcg-section-title">
                <FaArchway color="#0B3C7A" />
                <span>
                  {viewMode === 'flat'
                    ? 'All Accessible Railway Clusters'
                    : currentFolderId === null
                    ? 'Root Level Clusters'
                    : `Clusters in ${breadcrumbs[breadcrumbs.length - 1].name}`}
                </span>
                <span className="lcg-section-count">{currentClusters.length}</span>
              </h3>
            </div>

            {currentClusters.length === 0 ? (
              <div className="lcg-empty-box">
                <FaArchway className="lcg-empty-icon" />
                <h4 style={{ margin: '0 0 4px 0', color: '#1e293b' }}>
                  {viewMode === 'folder' && currentFolderId === null
                    ? 'Select a Scope Group Above'
                    : 'No Clusters Found in this Scope Group'}
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem' }}>
                  {viewMode === 'folder' && currentFolderId === null
                    ? 'Click on any Zonal or Divisional Scope Group card above to inspect clusters defined within it.'
                    : searchQuery
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
