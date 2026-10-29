import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { 
  FaMicrochip, FaServer, FaCheckCircle, FaSearch, FaSyncAlt, 
  FaTimes, FaSlidersH, FaBroadcastTower, FaCopy, FaCheck,
  FaTable, FaCode, FaHeartbeat, FaFileAlt, FaPaperPlane,
  FaTrash, FaExclamationTriangle, FaInfoCircle, FaBatteryFull, FaSignal, FaLayerGroup
} from 'react-icons/fa';
import type { User } from '../../types';
import { API_URL } from '../../config';
import { useToast } from '../../context/ToastContext';
import DeviceInfoModal from '../../components/DeviceInfoModal';
import './DeviceRegistryScreen.css';

/**
 * Universal key-value renderer for real device payloads
 */
function renderCleanKeyValueTable(data: any): ReactNode {
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
    <div className="table-responsive" style={{ border: '1px solid var(--border)', borderRadius: '8px', background: '#ffffff' }}>
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

interface DeviceItem {
  id: number;
  thingName: string;
  thingArn?: string | null;
  thingTypeName?: string | null;
  deviceType: string;
  serialNumber?: string | null;
  status: string;
  computedStatus?: string;
  latestPayloadSent?: string | null;
  latestTopic?: string | null;
  latestPayload?: any;
  gateId?: number | null;
  masterId?: number | null;
  childDeviceId?: number | null;
  macAddress?: string | null;
  imei?: string | null;
  firmwareVersion?: string | null;
  hardwareVersion?: string | null;
  dateOfMfg?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  batchNumber?: string | null;
  sensors?: any;
  components?: any;
  attributes?: any;
  metadata?: any;
  lastSeenAt?: string | null;
  createdAt: string;
  updatedAt: string;
  gate?: {
    id: number;
    lcNumber: string;
    name?: string | null;
    locationName: string;
    zone?: string | null;
    division?: string | null;
  } | null;
}

type Props = {
  user: User;
};

export default function DeviceRegistryScreen({ user: _user }: Props) {
  const { success: toastSuccess, error: toastError } = useToast();

  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Modals state
  const [selectedDeviceInfo, setSelectedDeviceInfo] = useState<any | null>(null);
  const [inspectDevice, setInspectDevice] = useState<DeviceItem | null>(null);
  const [historicPayloads, setHistoricPayloads] = useState<any[]>([]);
  const [telemetrySummary, setTelemetrySummary] = useState<any>(null);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);
  const [inspectTab, setInspectTab] = useState<'telemetry' | 'manifest' | 'health' | 'all'>('telemetry');
  const [selectedPayloadId, setSelectedPayloadId] = useState<number | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [telemetryViewMode, setTelemetryViewMode] = useState<'table' | 'raw'>('table');
  const [triggeringHealthCheck, setTriggeringHealthCheck] = useState<boolean>(false);
  const [healthCheckStage, setHealthCheckStage] = useState<'IDLE' | 'DISPATCHING' | 'LISTENING' | 'SUCCESS' | 'TIMEOUT'>('IDLE');

  // GitHub-style Device Deletion state
  const [deleteConfirmDevice, setDeleteConfirmDevice] = useState<DeviceItem | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState<string>('');
  const [deletingDevice, setDeletingDevice] = useState<boolean>(false);

  const fetchDevices = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.append('search', search.trim());
      if (statusFilter !== 'ALL') params.append('status', statusFilter);

      const res = await fetch(`${API_URL}/api/v1/devices?${params.toString()}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });

      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
      } else {
        const err = await res.json();
        if (!silent) toastError(err.error || 'Failed to load device registry', 'Device Registry');
      }
    } catch (err: any) {
      if (!silent) toastError(err.message || 'Network error fetching devices', 'Device Registry');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [search, statusFilter, toastError]);

  useEffect(() => {
    fetchDevices(false);
    // Background polling: silently update device power/GSM online statuses every 5 seconds
    const interval = setInterval(() => {
      fetchDevices(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchDevices]);


  // Load telemetry records for device
  const loadDeviceTelemetry = useCallback(async (device: DeviceItem, silent = false) => {
    if (!silent) setLoadingHistory(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/devices/${device.id}/telemetry`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        setHistoricPayloads(data.payloads || []);
        setTelemetrySummary(data);
      }
    } catch (err) {
      console.error('Failed to load telemetry', err);
    } finally {
      if (!silent) setLoadingHistory(false);
    }
  }, []);

  // Silently refresh device telemetry every 3 seconds while Inspect Modal is open
  // This ensures real-time updates when physical gate state changes (OPEN <-> CLOSED)
  useEffect(() => {
    if (!inspectDevice) return;
    const interval = setInterval(() => {
      loadDeviceTelemetry(inspectDevice, true);
    }, 3000);
    return () => clearInterval(interval);
  }, [inspectDevice, loadDeviceTelemetry]);

  // Open Inspect Modal
  const handleOpenInspect = async (device: DeviceItem) => {
    setInspectDevice(device);
    setSelectedPayloadId(null);
    setInspectTab('telemetry');
    await loadDeviceTelemetry(device, false);
  };

  // Trigger health check command over AWS IoT MQTT and wait for physical edge device response
  const handleTriggerHealthCheck = async () => {
    if (!inspectDevice) return;
    setTriggeringHealthCheck(true);
    setHealthCheckStage('DISPATCHING');
    setInspectTab('health');

    const triggerStartTime = Date.now();
    // Remember latest health check ID before triggering to detect any newly inserted record deterministically
    const initialMaxId = healthRecords.length > 0 ? Math.max(...healthRecords.map(h => typeof h.id === 'number' ? h.id : 0)) : 0;

    try {
      const res = await fetch(`${API_URL}/api/v1/devices/${inspectDevice.id}/health-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error || 'Failed to trigger health check', 'Health Check');
        setTriggeringHealthCheck(false);
        setHealthCheckStage('IDLE');
        return;
      }

      toastSuccess(`Diagnostic ping sent to ${data.topic || 'AWS IoT Core'}. Awaiting hardware packet...`, 'Command Dispatched');
      setHealthCheckStage('LISTENING');

      // Poll every 1.5s for up to 18s (12 attempts) to accommodate cellular 4G latency
      let attempts = 0;
      const maxAttempts = 12;
      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          // 1. Check dedicated health-checks endpoint
          const hcPollRes = await fetch(`${API_URL}/api/v1/devices/${inspectDevice.id}/health-checks`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
          });
          if (hcPollRes.ok) {
            const hcData = await hcPollRes.json();
            const checks: any[] = hcData.healthChecks || [];
            const matchingCheck = checks.find(c => {
              // Ensure it is a genuine response from hardware (with verdict or gateStatus or boomAngle)
              const isResponse = c.rawPayload?.action === 'HEALTH_CHECK_RESPONSE' ||
                                 c.gateStatus !== null ||
                                 c.boomAngle !== null ||
                                 c.uptimeSeconds !== null ||
                                 c.healthstatus !== undefined;
              if (!isResponse) return false;

              // Match by new ID, requestId echo, or recent timestamp window
              const isNewId = c.id && c.id > initialMaxId;
              const isMatchingReq = Boolean(data.requestId && c.requestId === data.requestId);
              const recTime = new Date(c.createdAt).getTime();
              const isWithinWindow = recTime >= triggerStartTime - 10000;
              return isNewId || isMatchingReq || isWithinWindow;
            });

            if (matchingCheck) {
              clearInterval(pollInterval);
              setTriggeringHealthCheck(false);
              setHealthCheckStage('SUCCESS');
              setSelectedPayloadId(matchingCheck.id);
              await loadDeviceTelemetry(inspectDevice, true);
              const displayBarrier = matchingCheck.gateStatus === 'NOT_CLOSED' ? 'OPEN' : (matchingCheck.gateStatus || 'REPORTED');
          toastSuccess(`Live response received from ${inspectDevice.thingName}! Barrier: ${displayBarrier} | Verdict: ${matchingCheck.healthstatus || 'HEALTHY'}`, 'Device Verified');
              return;
            }
          }

          // 2. Fallback check general telemetry payload cache
          const pollRes = await fetch(`${API_URL}/api/v1/devices/${inspectDevice.id}/telemetry`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
          });
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            const payloads: any[] = pollData.payloads || [];
            setHistoricPayloads(payloads);
            setTelemetrySummary(pollData);

            const foundHealthResponse = payloads.find(p => {
              const recTime = new Date(p.receivedAt).getTime();
              const isMatch = (data.requestId && p.payload?.requestId === data.requestId) || (recTime >= triggerStartTime - 1000);
              const isHealth = (p.topic || '').includes('/health') || p.payload?.action === 'HEALTH_CHECK_RESPONSE' || p.payload?.healthstatus !== undefined;
              const isNotRequestedOnly = p.status !== 'REQUESTED' && p.status !== 'PENDING';
              return isMatch && isHealth && isNotRequestedOnly;
            });

            if (foundHealthResponse) {
              clearInterval(pollInterval);
              setTriggeringHealthCheck(false);
              setHealthCheckStage('SUCCESS');
              setSelectedPayloadId(foundHealthResponse.id);
              toastSuccess(`Live response received from ${inspectDevice.thingName}! Verdict: ${foundHealthResponse.payload?.healthstatus || 'HEALTHY'}`, 'Device Verified');
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
          toastError(`No response from ${inspectDevice.thingName} within 12 seconds. Device may be powered down or out of cellular range.`, 'Device Timeout');
        }
      }, 1500);

    } catch (err: any) {
      toastError(err.message || 'Error triggering health check', 'Health Check');
      setTriggeringHealthCheck(false);
      setHealthCheckStage('IDLE');
    }
  };

  // Delete device from registry & database
  const handleDeleteDevice = async () => {
    if (!deleteConfirmDevice) return;
    setDeletingDevice(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/devices/${deleteConfirmDevice.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      });
      if (res.ok) {
        toastSuccess(`Device "${deleteConfirmDevice.thingName}" successfully deleted from registry.`, 'Device Deleted');
        setDeleteConfirmDevice(null);
        setDeleteConfirmInput('');
        await fetchDevices(false);
      } else {
        const err = await res.json().catch(() => ({}));
        toastError(err.error || 'Failed to delete device', 'Delete Failed');
      }
    } catch (err: any) {
      toastError(err.message || 'Network error deleting device', 'Delete Error');
    } finally {
      setDeletingDevice(false);
    }
  };


  // Filter devices in-memory for registry table
  const filteredDevices = useMemo(() => {
    return devices.filter((dev) => {
      const isOnline = dev.computedStatus === 'ONLINE';
      if (statusFilter === 'ONLINE' && !isOnline) return false;
      if (statusFilter === 'OFFLINE' && isOnline) return false;
      if (!search.trim()) return true;


      const q = search.toLowerCase();
      const matchThing = dev.thingName.toLowerCase().includes(q);
      const matchSerial = dev.serialNumber?.toLowerCase().includes(q);
      const matchGate = dev.gate?.lcNumber.toLowerCase().includes(q) || dev.gate?.locationName.toLowerCase().includes(q) || dev.gate?.name?.toLowerCase().includes(q);
      return matchThing || matchSerial || matchGate;
    });
  }, [devices, search, statusFilter]);

  // Categorize payloads cleanly according to the 3 types
  const telemetryRecords = useMemo(() => {
    return historicPayloads.filter(t => 
      ((t.topic && t.topic.includes('/telemetry')) ||
       (t.payload && typeof t.payload === 'object' && ((t.payload as any).Status !== undefined || (t.payload as any).LimitSwitchClosed !== undefined))) &&
      !(t.topic && t.topic.includes('/health')) &&
      !((t.payload as any)?.action === 'HEALTH_CHECK' || (t.payload as any)?.action === 'HEALTH_CHECK_RESPONSE' || (t.payload as any)?.healthstatus !== undefined)
    );
  }, [historicPayloads]);

  const manifestRecords = useMemo(() => {
    return historicPayloads.filter(t => 
      (t.topic && t.topic.includes('/manifest')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
    );
  }, [historicPayloads]);

  const healthRecords = useMemo(() => {
    const list = historicPayloads.filter(t => 
      t.isDedicatedHealthCheck ||
      (t.topic && t.topic.includes('/health')) ||
      (t.payload && typeof t.payload === 'object' && (
        (t.payload as any).action === 'HEALTH_CHECK' ||
        (t.payload as any).action === 'HEALTH_CHECK_RESPONSE' ||
        (t.payload as any).healthstatus !== undefined ||
        (t.payload as any).BoomAngle !== undefined ||
        (t.payload as any).NetworkStrength !== undefined ||
        (t.payload as any).BatteryPercentage !== undefined
      ))
    );
    const seen = new Set<string>();
    return list.filter(item => {
      const key = `${item.isDedicatedHealthCheck ? 'hc' : 'tel'}-${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [historicPayloads]);

  // Selected item according to active tab
  const activeRecordList = useMemo(() => {
    if (inspectTab === 'telemetry') return telemetryRecords;
    if (inspectTab === 'manifest') return manifestRecords;
    if (inspectTab === 'health') return healthRecords;
    return historicPayloads;
  }, [inspectTab, telemetryRecords, manifestRecords, healthRecords, historicPayloads]);

  const currentViewingRecord = useMemo(() => {
    if (selectedPayloadId !== null) {
      const found = historicPayloads.find(p => p.id === selectedPayloadId);
      if (found) return found;
    }
    if (activeRecordList.length > 0) return activeRecordList[0];
    if (inspectTab === 'manifest' && telemetrySummary?.latestManifest) {
      return telemetrySummary.latestManifest;
    }
    return null;
  }, [selectedPayloadId, historicPayloads, activeRecordList, inspectTab, telemetrySummary]);

  // Registry summary stats
  const totalCount = devices.length;
  const onlineCount = devices.filter(d => d.computedStatus === 'ONLINE').length;
  const offlineCount = totalCount - onlineCount;
  const assignedCount = devices.filter(d => Boolean(d.gateId)).length;


  return (
    <div className="device-registry-container">
      {/* KPI Stats Bar */}
      <div className="registry-stats-grid">
        <div className="stat-card">
          <div className="stat-icon-wrapper blue">
            <FaBroadcastTower />
          </div>
          <div className="stat-info">
            <span className="stat-label">Total IoT Devices</span>
            <span className="stat-value">{totalCount}</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrapper green">
            <FaCheckCircle />
          </div>
          <div className="stat-info">
            <span className="stat-label">Live Active</span>
            <span className="stat-value">{onlineCount}</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrapper gray">
            <FaServer />
          </div>
          <div className="stat-info">
            <span className="stat-label">Offline</span>
            <span className="stat-value">{offlineCount}</span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon-wrapper purple">
            <FaMicrochip />
          </div>
          <div className="stat-info">
            <span className="stat-label">Assigned to Gates</span>
            <span className="stat-value">{assignedCount}</span>
          </div>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="registry-controls-bar">
        <div className="search-box">
          <FaSearch className="search-icon" size={14} />
          <input
            type="text"
            placeholder="Search by Thing Name, Serial Number, or LC Gate..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="clear-btn" onClick={() => setSearch('')}>
              <FaTimes size={12} />
            </button>
          )}
        </div>

        <div className="filter-group">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="ALL">All Statuses</option>
            <option value="ONLINE">Active / Online</option>
            <option value="OFFLINE">Offline</option>
          </select>
        </div>

        <button 
          type="button" 
          className="registry-refresh-btn" 
          onClick={() => fetchDevices(false)} 
          disabled={loading}
          title="Refresh device registry"
        >
          <FaSyncAlt className={loading ? 'fa-spin' : ''} size={13} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Device Registry Table */}
      <div className="registry-table-card">
        {loading ? (
          <div className="empty-state">
            <FaSyncAlt className="fa-spin empty-state-icon" />
            <p className="text-muted">Loading registered devices from RDS database...</p>
          </div>
        ) : filteredDevices.length === 0 ? (
          <div className="empty-state">
            <FaMicrochip className="empty-state-icon" />
            <h3>No Devices Found</h3>
            <p className="text-muted">
              Devices provisioned in AWS IoT Core reporting over MQTT will automatically appear here.
            </p>
          </div>
        ) : (
          <table className="dynamic-table">
            <thead>
              <tr>
                <th>Thing Name / S.No.</th>
                <th>Type</th>
                <th>Status</th>
                <th>Assigned Cluster / Gate</th>
                <th>Firmware</th>
                <th>Latest Payload Sent</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((device) => {
                const isOnline = device.computedStatus === 'ONLINE';

                return (
                  <tr key={device.id}>
                    {/* Thing Name */}
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '0.92rem' }}>
                          {device.thingName}
                        </span>
                        {device.serialNumber && device.serialNumber !== device.thingName && (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            SN: {device.serialNumber}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Device Type */}
                    <td>
                      <span className="badge badge-indigo" style={{ fontSize: '0.75rem', padding: '3px 8px' }}>
                        {device.deviceType}
                      </span>
                    </td>

                    {/* Status Pill */}
                    <td>
                      <span className={`status-pill ${isOnline ? 'online' : 'offline'}`}>
                        <span className="status-dot" />
                        {isOnline ? 'ONLINE' : 'OFFLINE'}
                      </span>
                    </td>

                    {/* Assigned LC Gate */}
                    <td>
                      {device.gate ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '0.86rem' }}>
                            {device.gate.lcNumber}
                          </span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {device.gate.locationName} ({device.gate.zone || 'Zone'})
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted" style={{ fontStyle: 'italic', fontSize: '0.82rem' }}>
                          Unassigned
                        </span>
                      )}
                    </td>

                    {/* Firmware */}
                    <td>
                      <code style={{ fontSize: '0.78rem', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>
                        {device.firmwareVersion || '1.0.0'}
                      </code>
                    </td>

                    {/* Latest Payload Sent Column */}
                    <td>
                      {device.latestPayloadSent ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontWeight: 600, fontSize: '0.86rem', color: 'var(--text-main)' }}>
                            {new Date(device.latestPayloadSent).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}
                          </span>
                          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                            {new Date(device.latestPayloadSent).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted" style={{ fontSize: '0.85rem' }}>—</span>
                      )}
                    </td>

                    {/* Actions: Device Info, Inspect & Delete */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button 
                          type="button" 
                          className="btn-small btn-primary flex items-center gap-1.5"
                          style={{ padding: '6px 11px', fontSize: '0.8rem', cursor: 'pointer' }}
                          onClick={() => setSelectedDeviceInfo(device)}
                          title="View hardware & manifest profile"
                        >
                          <FaMicrochip size={12} /> Device Info
                        </button>

                        <button 
                          type="button" 
                          className="btn-small btn-outline flex items-center gap-1.5"
                          style={{ padding: '6px 11px', fontSize: '0.8rem', cursor: 'pointer' }}
                          onClick={() => handleOpenInspect(device)}
                          title="Inspect telemetry payloads"
                        >
                          <FaSlidersH size={12} /> Inspect
                        </button>

                        <button 
                          type="button" 
                          className="btn-small btn-outline flex items-center gap-1"
                          style={{
                            padding: '6px 10px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            color: '#dc2626',
                            borderColor: '#fca5a5',
                            background: '#fef2f2'
                          }}
                          onClick={() => {
                            setDeleteConfirmDevice(device);
                            setDeleteConfirmInput('');
                          }}
                          title={`Delete device ${device.thingName} from registry`}
                        >
                          <FaTrash size={11} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 1. Device Info Modal */}
      {selectedDeviceInfo && (
        <DeviceInfoModal
          isOpen={Boolean(selectedDeviceInfo)}
          onClose={() => setSelectedDeviceInfo(null)}
          master={selectedDeviceInfo}
        />
      )}

      {/* 2. Professional Payload Inspector Modal */}
      {inspectDevice && (
        <div className="device-modal-overlay" onClick={() => setInspectDevice(null)}>
          <div className="device-modal-content slide-up" style={{ maxWidth: '1060px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="device-modal-header flex justify-between items-center pb-3 border-b" style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid #e2e8f0' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.3px' }}>
                    {inspectDevice.thingName}
                  </h2>
                  <span
                    style={{
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      padding: '4px 10px',
                      borderRadius: '6px',
                      background: '#eff6ff',
                      color: '#1d4ed8',
                      border: '1px solid #bfdbfe',
                      letterSpacing: '0.4px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5
                    }}
                  >
                    <FaServer size={11} /> AWS IoT Core
                  </span>
                  {inspectDevice.gate && (
                    <span
                      style={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: '#334155',
                        background: '#f8fafc',
                        padding: '4px 10px',
                        borderRadius: '6px',
                        border: '1px solid #e2e8f0',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6
                      }}
                    >
                      <FaLayerGroup size={11} color="#64748b" />
                      {inspectDevice.gate.lcNumber} • {inspectDevice.gate.locationName}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '4px 10px',
                      borderRadius: '6px',
                      letterSpacing: '0.4px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: inspectDevice.computedStatus === 'ONLINE' ? '#ecfdf5' : '#fef2f2',
                      color: inspectDevice.computedStatus === 'ONLINE' ? '#047857' : '#b91c1c',
                      border: `1px solid ${inspectDevice.computedStatus === 'ONLINE' ? '#a7f3d0' : '#fecaca'}`
                    }}
                  >
                    <span
                      className={inspectDevice.computedStatus === 'ONLINE' ? 'pulse-dot' : 'status-dot'}
                      style={{ width: 7, height: 7, backgroundColor: inspectDevice.computedStatus === 'ONLINE' ? '#10b981' : '#ef4444' }}
                    />
                    {inspectDevice.computedStatus === 'ONLINE' ? 'ONLINE' : 'OFFLINE'}
                  </span>

                  {telemetrySummary?.currentStatus && (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '4px 10px',
                        borderRadius: '6px',
                        letterSpacing: '0.4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        background: telemetrySummary.currentStatus === 'CLOSED' ? '#ecfdf5' : '#fef2f2',
                        color: telemetrySummary.currentStatus === 'CLOSED' ? '#047857' : '#b91c1c',
                        border: `1px solid ${telemetrySummary.currentStatus === 'CLOSED' ? '#a7f3d0' : '#fecaca'}`
                      }}
                      title="Real-time physical barrier limit switch state"
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          backgroundColor: telemetrySummary.currentStatus === 'CLOSED' ? '#10b981' : '#ef4444'
                        }}
                      />
                      GATE: {telemetrySummary.currentStatus}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Manual Refresh */}
                <button
                  type="button"
                  className="btn-small btn-outline flex items-center gap-1.5"
                  style={{ fontSize: '0.8rem', padding: '6px 12px', height: '32px', borderRadius: '6px', fontWeight: 600 }}
                  onClick={() => loadDeviceTelemetry(inspectDevice, false)}
                  disabled={loadingHistory}
                  title="Fetch latest telemetry and manifest records"
                >
                  <FaSyncAlt className={loadingHistory ? 'fa-spin' : ''} size={11} />
                  <span>{loadingHistory ? 'Syncing...' : 'Refresh'}</span>
                </button>

                {/* Modal Close Button */}
                <button 
                  type="button" 
                  onClick={() => setInspectDevice(null)}
                  style={{
                    width: '32px',
                    height: '32px',
                    padding: 0,
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    background: '#f8fafc',
                    color: '#475569',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    marginLeft: '4px',
                    transition: 'all 0.15s ease'
                  }}
                  aria-label="Close Inspector"
                  title="Close Inspector"
                >
                  <FaTimes size={14} />
                </button>
              </div>
            </div>

            {/* Sub-header Tabs: 3 Main Payload Types */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', padding: '0.75rem 0', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                {/* Tab 1: Telemetry */}
                <button
                  type="button"
                  className={`telemetry-tab-btn ${inspectTab === 'telemetry' ? 'active' : ''}`}
                  onClick={() => {
                    setInspectTab('telemetry');
                    setSelectedPayloadId(null);
                  }}
                >
                  <FaBroadcastTower size={13} />
                  <span>Telemetry</span>
                  <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                    {telemetryRecords.length}
                  </span>
                </button>

                {/* Tab 2: Manifest */}
                <button
                  type="button"
                  className={`telemetry-tab-btn ${inspectTab === 'manifest' ? 'active' : ''}`}
                  onClick={() => {
                    setInspectTab('manifest');
                    setSelectedPayloadId(null);
                  }}
                >
                  <FaFileAlt size={13} />
                  <span>Manifest</span>
                  <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                    {manifestRecords.length || (telemetrySummary?.latestManifest ? 1 : 0)}
                  </span>
                </button>

                {/* Tab 3: Health Check */}
                <button
                  type="button"
                  className={`telemetry-tab-btn ${inspectTab === 'health' ? 'active' : ''}`}
                  onClick={() => {
                    setInspectTab('health');
                    setSelectedPayloadId(null);
                  }}
                >
                  <FaHeartbeat size={13} />
                  <span>Health Check</span>
                  <span className="badge badge-indigo" style={{ fontSize: '0.7rem', padding: '1px 6px', marginLeft: 4 }}>
                    {healthRecords.length}
                  </span>
                </button>

                {/* Tab 4: All Messages */}
                <button
                  type="button"
                  className={`telemetry-tab-btn ${inspectTab === 'all' ? 'active' : ''}`}
                  onClick={() => {
                    setInspectTab('all');
                    setSelectedPayloadId(null);
                  }}
                >
                  <FaServer size={13} />
                  <span>All Records ({historicPayloads.length})</span>
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="device-modal-body" style={{ padding: '1rem 0' }}>
              {loadingHistory && historicPayloads.length === 0 ? (
                <div className="empty-state py-8">
                  <FaSyncAlt className="fa-spin" style={{ fontSize: '1.8rem', color: 'var(--primary)', marginBottom: '0.5rem' }} />
                  <p className="text-muted">Loading recorded messages from database...</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                  
                  {/* TAB 1: TELEMETRY VIEW */}
                  {inspectTab === 'telemetry' && (
                    <div>
                      {/* Topic banner */}
                      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
                            MQTT Telemetry Topic
                          </div>
                          <code style={{ fontSize: '0.85rem', color: '#0369a1', fontWeight: 600 }}>
                            lc-gate/{inspectDevice.thingName}/telemetry
                          </code>
                        </div>
                        {/* Real-time Physical Gate Status Banner */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: '0.8rem', color: '#475569', fontWeight: 600 }}>Live Barrier State:</span>
                          <span
                            style={{
                              padding: '4px 14px',
                              borderRadius: '6px',
                              fontWeight: 800,
                              fontSize: '0.9rem',
                              letterSpacing: '0.4px',
                              background: (telemetrySummary?.currentStatus || telemetryRecords[0]?.status || 'CLOSED') === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                              color: (telemetrySummary?.currentStatus || telemetryRecords[0]?.status || 'CLOSED') === 'CLOSED' ? '#15803d' : '#b91c1c',
                              border: `1px solid ${(telemetrySummary?.currentStatus || telemetryRecords[0]?.status || 'CLOSED') === 'CLOSED' ? '#86efac' : '#fca5a5'}`
                            }}
                          >
                            {telemetrySummary?.currentStatus || telemetryRecords[0]?.status || 'CLOSED'}
                          </span>
                        </div>
                      </div>

                      {/* Selected Telemetry Payload Presentation */}
                      {currentViewingRecord ? (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.88rem', fontWeight: 750, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                                Payload Breakdown
                                <span style={{ fontSize: '0.74rem', fontWeight: 500, color: '#64748b' }}>
                                  ({new Date(currentViewingRecord.receivedAt).toLocaleTimeString()} • {new Date(currentViewingRecord.receivedAt).toLocaleDateString()})
                                </span>
                              </span>
                              {selectedPayloadId === null ? (
                                <span className="badge badge-emerald" style={{ fontSize: '0.7rem', padding: '2px 7px' }}>
                                  ● Live Auto-Updating
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-small btn-outline"
                                  style={{ fontSize: '0.72rem', padding: '1px 8px', color: '#0284c7', borderColor: '#bae6fd' }}
                                  onClick={() => setSelectedPayloadId(null)}
                                  title="Return to latest incoming telemetry stream"
                                >
                                  Switch to Live Latest
                                </button>
                              )}
                            </div>

                            {/* View Format Toggle & Copy embedded directly inside the Payload Breakdown section */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex' }}>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'table' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('table')}
                                >
                                  <FaTable size={11} /> Table View
                                </button>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'raw' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('raw')}
                                >
                                  <FaCode size={11} /> Raw JSON
                                </button>
                              </div>

                              <button
                                type="button"
                                className="btn-small btn-outline"
                                style={{ fontSize: '0.74rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(currentViewingRecord.payload, null, 2));
                                  setIsCopied(true);
                                  setTimeout(() => setIsCopied(false), 2000);
                                  toastSuccess('Payload copied to clipboard', 'Copied');
                                }}
                              >
                                {isCopied ? <FaCheck color="#10b981" /> : <FaCopy />} {isCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          </div>

                          {telemetryViewMode === 'table' ? (
                            renderCleanKeyValueTable(currentViewingRecord.payload)
                          ) : (
                            <div style={{ background: '#0f172a', borderRadius: '8px', padding: '1rem', border: '1px solid #1e293b' }}>
                              <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '300px', overflowY: 'auto' }}>
                                {JSON.stringify(currentViewingRecord.payload, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="empty-state py-6" style={{ textAlign: 'center', background: '#f8fafc', borderRadius: '8px', border: '1px dashed #cbd5e1' }}>
                          <FaBroadcastTower size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                          <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Telemetry Payloads Received Yet</h4>
                          <p className="text-muted" style={{ fontSize: '0.84rem', margin: 0 }}>
                            Awaiting real-time telemetry from edge device on MQTT topic <code>lc-gate/{inspectDevice.thingName}/telemetry</code>.
                          </p>
                        </div>
                      )}

                      {/* Historic Telemetry Table */}
                      {telemetryRecords.length > 0 && (
                        <div>
                          <div className="flex justify-between items-center mb-2 mt-4">
                            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                              Historic Telemetry Stream ({telemetryRecords.length} Messages)
                            </span>
                            <small className="text-muted">Click row to view payload</small>
                          </div>

                          <div className="table-responsive" style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                            <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '35px' }}>#</th>
                                  <th>Received Time</th>
                                  <th>Status</th>
                                  <th>Limit Switch</th>
                                  <th>Hall Effect</th>
                                  <th>Time Stamp</th>
                                  <th style={{ textAlign: 'right' }}>Action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {telemetryRecords.map((item, idx) => {
                                  const isSelected = currentViewingRecord?.id === item.id;
                                  const p = item.payload || {};
                                  const status = p.Status || '—';

                                  return (
                                    <tr 
                                      key={`tel-${item.id || 'rec'}-${idx}`}
                                      style={{ backgroundColor: isSelected ? '#f1f5f9' : undefined, cursor: 'pointer' }}
                                      onClick={() => setSelectedPayloadId(item.id)}
                                    >
                                      <td style={{ fontWeight: 700, color: isSelected ? 'var(--primary)' : 'inherit' }}>
                                        {idx + 1}
                                      </td>
                                      <td>
                                        <strong>{new Date(item.receivedAt).toLocaleTimeString()}</strong>
                                        <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                                          {new Date(item.receivedAt).toLocaleDateString()}
                                        </div>
                                      </td>
                                      <td>
                                        <span
                                          style={{
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            fontWeight: 700,
                                            fontSize: '0.78rem',
                                            background: String(status).toUpperCase() === 'CLOSED' ? '#dcfce7' : '#fee2e2',
                                            color: String(status).toUpperCase() === 'CLOSED' ? '#15803d' : '#b91c1c'
                                          }}
                                        >
                                          {status}
                                        </span>
                                      </td>
                                      <td>
                                        {p.LimitSwitchClosed !== undefined ? (
                                          <span style={{ fontWeight: 600, color: p.LimitSwitchClosed ? '#15803d' : '#475569' }}>
                                            {p.LimitSwitchClosed ? 'Closed' : 'Open'}
                                          </span>
                                        ) : '—'}
                                      </td>
                                      <td>
                                        {p.HallClosed !== undefined ? (
                                          <span style={{ fontWeight: 600, color: p.HallClosed ? '#15803d' : '#475569' }}>
                                            {p.HallClosed ? 'Closed' : 'Open'}
                                          </span>
                                        ) : '—'}
                                      </td>
                                      <td>
                                        {p.TimeStampMs !== undefined ? `${p.TimeStampMs} ms` : '—'}
                                      </td>
                                      <td style={{ textAlign: 'right' }}>
                                        <button
                                          type="button"
                                          className={`btn-small ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                                          style={{ padding: '2px 8px', fontSize: '0.74rem' }}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedPayloadId(item.id);
                                          }}
                                        >
                                          {isSelected ? 'Viewing' : 'Inspect'}
                                        </button>
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
                  )}

                  {/* TAB 2: MANIFEST VIEW */}
                  {inspectTab === 'manifest' && (
                    <div>
                      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
                          Device Hardware Manifest Topic
                        </div>
                        <code style={{ fontSize: '0.85rem', color: '#0369a1', fontWeight: 600 }}>
                          lc/devices/{inspectDevice.thingName}/manifest
                        </code>
                      </div>

                      {currentViewingRecord ? (
                        <div>
                          <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                            <div>
                              <span style={{ fontSize: '0.88rem', fontWeight: 750, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                                Configuration & Hardware Manifest
                                <span style={{ fontSize: '0.74rem', fontWeight: 500, color: '#64748b' }}>
                                  ({new Date(currentViewingRecord.receivedAt).toLocaleString()})
                                </span>
                              </span>
                            </div>

                            {/* View Format Toggle & Copy */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex' }}>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'table' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('table')}
                                >
                                  <FaTable size={11} /> Table View
                                </button>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'raw' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('raw')}
                                >
                                  <FaCode size={11} /> Raw JSON
                                </button>
                              </div>

                              <button
                                type="button"
                                className="btn-small btn-outline"
                                style={{ fontSize: '0.74rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(currentViewingRecord.payload, null, 2));
                                  setIsCopied(true);
                                  setTimeout(() => setIsCopied(false), 2000);
                                  toastSuccess('Manifest copied to clipboard', 'Copied');
                                }}
                              >
                                {isCopied ? <FaCheck color="#10b981" /> : <FaCopy />} {isCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          </div>

                          {telemetryViewMode === 'table' ? (
                            renderCleanKeyValueTable(currentViewingRecord.payload)
                          ) : (
                            <div style={{ background: '#0f172a', borderRadius: '8px', padding: '1rem', border: '1px solid #1e293b' }}>
                              <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '360px', overflowY: 'auto' }}>
                                {JSON.stringify(currentViewingRecord.payload, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="empty-state py-6" style={{ textAlign: 'center', background: '#f8fafc', borderRadius: '8px', border: '1px dashed #cbd5e1' }}>
                          <FaFileAlt size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                          <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Manifest Payload Received</h4>
                          <p className="text-muted" style={{ fontSize: '0.84rem', margin: 0 }}>
                            Device configuration manifest will appear when device publishes to <code>lc/devices/{inspectDevice.thingName}/manifest</code>.
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 3: HEALTH CHECK VIEW */}
                  {inspectTab === 'health' && (
                    <div>
                      {/* Health Check Trigger Action */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '1rem' }}>
                        <button
                          type="button"
                          className="btn-primary flex items-center gap-2"
                          style={{ padding: '8px 18px', fontSize: '0.86rem', fontWeight: 700, borderRadius: '6px' }}
                          onClick={handleTriggerHealthCheck}
                          disabled={triggeringHealthCheck}
                        >
                          <FaPaperPlane size={12} className={triggeringHealthCheck ? 'fa-spin' : ''} />
                          {triggeringHealthCheck ? 'Testing Hardware...' : 'Trigger Health Check'}
                        </button>
                      </div>

                      {/* Live Diagnostic State Banner */}
                      {healthCheckStage === 'LISTENING' && (
                        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '1rem 1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                          <FaSyncAlt className="fa-spin" size={24} color="#0284c7" />
                          <div>
                            <h4 style={{ margin: 0, fontSize: '0.96rem', fontWeight: 700, color: '#0369a1' }}>
                              Diagnostic Command Dispatched — Awaiting Edge Hardware Packet...
                            </h4>
                            <p style={{ margin: '3px 0 0 0', fontSize: '0.82rem', color: '#0284c7' }}>
                              MQTT ping published to <code>lc-gate/{inspectDevice.thingName}/health/request</code>. 
                              Sampling battery voltage, solar cut-in, cellular signal, and barrier limit sensors...
                            </p>
                          </div>
                        </div>
                      )}

                      {healthCheckStage === 'TIMEOUT' && (
                        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '1rem 1.25rem', marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <FaExclamationTriangle size={22} color="#dc2626" />
                            <div>
                              <h4 style={{ margin: 0, fontSize: '0.96rem', fontWeight: 700, color: '#991b1b' }}>
                                Diagnostic Timed Out: No Packet Returned by Edge Hardware
                              </h4>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn-small btn-primary"
                            onClick={handleTriggerHealthCheck}
                          >
                            Retry Diagnostic Ping
                          </button>
                        </div>
                      )}

                      {healthCheckStage === 'SUCCESS' && (
                        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '0.85rem 1.25rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <FaCheckCircle size={20} color="#16a34a" />
                          <div>
                            <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#166534' }}>
                              Diagnostic Response Verified from Edge Hardware
                            </h4>
                            <p style={{ margin: '2px 0 0 0', fontSize: '0.82rem', color: '#15803d' }}>
                              Physical device received MQTT command, read internal sensors, and published complete system telemetry.
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Diagnostic Summary KPI Quick Grid */}
                      {currentViewingRecord && !((currentViewingRecord.topic || '').includes('/request')) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '1.25rem' }}>
                          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <FaHeartbeat color="#10b981" /> System Verdict
                            </div>
                            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                              {currentViewingRecord.payload?.healthstatus || currentViewingRecord.payload?.status || 'HEALTHY'}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: '#059669', fontWeight: 600 }}>
                              {currentViewingRecord.payload?.FirmwareVersion ? `Firmware v${currentViewingRecord.payload.FirmwareVersion}` : 'Hardware Verified Live'}
                            </div>
                          </div>

                          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <FaBatteryFull color="#0284c7" /> Battery & Power
                            </div>
                            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                              {currentViewingRecord.payload?.BatteryVoltage !== null && currentViewingRecord.payload?.BatteryVoltage !== undefined
                                ? `${currentViewingRecord.payload.BatteryVoltage} V`
                                : currentViewingRecord.payload?.BatteryPercentage !== null && currentViewingRecord.payload?.BatteryPercentage !== undefined
                                ? `${currentViewingRecord.payload.BatteryPercentage}%`
                                : 'Mains / Unmonitored'}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                              Solar: {currentViewingRecord.payload?.SolarVoltage !== null && currentViewingRecord.payload?.SolarVoltage !== undefined
                                ? `${currentViewingRecord.payload.SolarVoltage} V`
                                : currentViewingRecord.payload?.SolarCharging ? 'Solar Active' : 'Unmonitored'}
                            </div>
                          </div>

                          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <FaSignal color="#8b5cf6" /> Cellular Modem
                            </div>
                            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                              {currentViewingRecord.payload?.SignalStrength !== undefined && currentViewingRecord.payload?.SignalStrength !== null
                                ? `${currentViewingRecord.payload.SignalStrength} CSQ`
                                : currentViewingRecord.payload?.NetworkStrength || 'Connected'}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                              {currentViewingRecord.payload?.NetworkType || '4G LTE'} {currentViewingRecord.payload?.McuTempC !== undefined ? `| ${currentViewingRecord.payload.McuTempC}°C` : ''}
                            </div>
                          </div>

                          <div style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 5 }}>
                              <FaMicrochip color="#d97706" /> Gate & Sensors
                            </div>
                            <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#0f172a', marginTop: 4 }}>
                              {(currentViewingRecord.payload?.Status === 'NOT_CLOSED' ? 'OPEN' : currentViewingRecord.payload?.Status) || (currentViewingRecord.payload?.LimitSwitchClosed ? 'CLOSED' : 'OPEN')}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: '#64748b' }}>
                              Boom: {currentViewingRecord.payload?.BoomAngle !== undefined ? `${currentViewingRecord.payload.BoomAngle}°` : '0.0°'} | Limit: {currentViewingRecord.payload?.LimitSwitchClosed ? 'Closed' : 'Open'}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Latest Health Check Response Payload */}
                      {currentViewingRecord ? (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                            <div>
                              <span style={{ fontSize: '0.88rem', fontWeight: 750, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                                Health Check Payload
                                <span style={{ fontSize: '0.74rem', fontWeight: 500, color: '#64748b' }}>
                                  ({new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                                </span>
                              </span>
                            </div>

                            {/* View Format Toggle & Copy */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex' }}>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'table' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('table')}
                                >
                                  <FaTable size={11} /> Table View
                                </button>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'raw' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('raw')}
                                >
                                  <FaCode size={11} /> Raw JSON
                                </button>
                              </div>

                              <button
                                type="button"
                                className="btn-small btn-outline"
                                style={{ fontSize: '0.74rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(currentViewingRecord.payload, null, 2));
                                  setIsCopied(true);
                                  setTimeout(() => setIsCopied(false), 2000);
                                  toastSuccess('Health payload copied to clipboard', 'Copied');
                                }}
                              >
                                {isCopied ? <FaCheck color="#10b981" /> : <FaCopy />} {isCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          </div>

                          {telemetryViewMode === 'table' ? (
                            renderCleanKeyValueTable(currentViewingRecord.payload)
                          ) : (
                            <div style={{ background: '#0f172a', borderRadius: '8px', padding: '1rem', border: '1px solid #1e293b' }}>
                              <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '300px', overflowY: 'auto' }}>
                                {JSON.stringify(currentViewingRecord.payload, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="empty-state py-6" style={{ textAlign: 'center', background: '#f8fafc', borderRadius: '8px', border: '1px dashed #cbd5e1' }}>
                          <FaHeartbeat size={28} style={{ color: '#94a3b8', margin: '0 auto 8px auto' }} />
                          <h4 style={{ margin: '0 0 4px 0', color: '#1e293b', fontWeight: 700 }}>No Health Check Responses Yet</h4>
                          <p className="text-muted" style={{ fontSize: '0.84rem', margin: '0 0 12px 0' }}>
                            Click &ldquo;Trigger Health Check&rdquo; to send a diagnostic test command to the device over AWS IoT Core MQTT.
                          </p>
                        </div>
                      )}

                      {/* Health Check History Table */}
                      {healthRecords.length > 0 && (
                        <div>
                          <div className="flex justify-between items-center mb-2 mt-4">
                            <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                              Health Check Audit Log ({healthRecords.length} Events)
                            </span>
                          </div>

                          <div className="table-responsive" style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                            <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '35px' }}>#</th>
                                  <th>Event Time</th>
                                  <th>Topic</th>
                                  <th>Event Type</th>
                                  <th>Status</th>
                                  <th style={{ textAlign: 'right' }}>Action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {healthRecords.map((item, idx) => {
                                  const isSelected = currentViewingRecord?.id === item.id;
                                  const isReq = (item.topic || '').includes('/request') || item.status === 'REQUESTED';

                                  return (
                                    <tr 
                                      key={`${item.isDedicatedHealthCheck ? 'hc' : 'tel'}-${item.id || 'rec'}-${idx}`}
                                      style={{ backgroundColor: isSelected ? '#f1f5f9' : undefined, cursor: 'pointer' }}
                                      onClick={() => setSelectedPayloadId(item.id)}
                                    >
                                      <td>{idx + 1}</td>
                                      <td>{new Date(item.receivedAt).toLocaleTimeString()}</td>
                                      <td>
                                        <code style={{ fontSize: '0.78rem' }}>{item.topic}</code>
                                      </td>
                                      <td>
                                        <span className={`badge ${isReq ? 'badge-amber' : 'badge-emerald'}`} style={{ fontSize: '0.72rem' }}>
                                          {isReq ? 'Command Dispatched' : 'Device Health Response'}
                                        </span>
                                      </td>
                                      <td>{item.status || 'OK'}</td>
                                      <td style={{ textAlign: 'right' }}>
                                        <button
                                          type="button"
                                          className={`btn-small ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                                          style={{ padding: '2px 8px', fontSize: '0.74rem' }}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedPayloadId(item.id);
                                          }}
                                        >
                                          {isSelected ? 'Viewing' : 'Inspect'}
                                        </button>
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
                  )}

                  {/* TAB 4: ALL RECORDS TABLE */}
                  {inspectTab === 'all' && (
                    <div>
                      {currentViewingRecord && (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="flex justify-between items-center mb-2 flex-wrap gap-2">
                            <div>
                              <span style={{ fontSize: '0.88rem', fontWeight: 750, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                                Selected Payload
                                <span style={{ fontSize: '0.74rem', fontWeight: 500, color: '#64748b' }}>
                                  ({currentViewingRecord.topic} • {new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                                </span>
                              </span>
                            </div>

                            {/* View Format Toggle & Copy */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex' }}>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'table' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('table')}
                                >
                                  <FaTable size={11} /> Table View
                                </button>
                                <button
                                  type="button"
                                  className={`telemetry-tab-btn ${telemetryViewMode === 'raw' ? 'active' : ''}`}
                                  style={{ fontSize: '0.74rem', padding: '3px 9px' }}
                                  onClick={() => setTelemetryViewMode('raw')}
                                >
                                  <FaCode size={11} /> Raw JSON
                                </button>
                              </div>

                              <button
                                type="button"
                                className="btn-small btn-outline"
                                style={{ fontSize: '0.74rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(currentViewingRecord.payload, null, 2));
                                  setIsCopied(true);
                                  setTimeout(() => setIsCopied(false), 2000);
                                  toastSuccess('Payload copied to clipboard', 'Copied');
                                }}
                              >
                                {isCopied ? <FaCheck color="#10b981" /> : <FaCopy />} {isCopied ? 'Copied' : 'Copy'}
                              </button>
                            </div>
                          </div>

                          {telemetryViewMode === 'table' ? (
                            renderCleanKeyValueTable(currentViewingRecord.payload)
                          ) : (
                            <div style={{ background: '#0f172a', borderRadius: '8px', padding: '1rem', border: '1px solid #1e293b' }}>
                              <pre style={{ margin: 0, color: '#38bdf8', fontSize: '0.82rem', fontFamily: 'monospace', maxHeight: '300px', overflowY: 'auto' }}>
                                {JSON.stringify(currentViewingRecord.payload, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="table-responsive" style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                        <table className="dynamic-table" style={{ width: '100%', fontSize: '0.84rem' }}>
                          <thead>
                            <tr>
                              <th style={{ width: '35px' }}>#</th>
                              <th>Received Time</th>
                              <th>Topic</th>
                              <th>Payload Type</th>
                              <th>Status</th>
                              <th style={{ textAlign: 'right' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {historicPayloads.map((item, idx) => {
                              const isSelected = currentViewingRecord?.id === item.id;
                              let typeLabel = 'Telemetry';
                              let badgeColor = 'badge-indigo';
                              if ((item.topic || '').includes('/manifest')) {
                                typeLabel = 'Manifest';
                                badgeColor = 'badge-blue';
                              } else if ((item.topic || '').includes('/health')) {
                                typeLabel = 'Health Check';
                                badgeColor = 'badge-emerald';
                              }

                              return (
                                <tr 
                                  key={`all-${item.isDedicatedHealthCheck ? 'hc' : 'tel'}-${item.id || 'rec'}-${idx}`}
                                  style={{ backgroundColor: isSelected ? '#f1f5f9' : undefined, cursor: 'pointer' }}
                                  onClick={() => setSelectedPayloadId(item.id)}
                                >
                                  <td>{idx + 1}</td>
                                  <td>{new Date(item.receivedAt).toLocaleString()}</td>
                                  <td>
                                    <code style={{ fontSize: '0.78rem' }}>{item.topic}</code>
                                  </td>
                                  <td>
                                    <span className={`badge ${badgeColor}`} style={{ fontSize: '0.72rem' }}>
                                      {typeLabel}
                                    </span>
                                  </td>
                                  <td>{item.status || 'OK'}</td>
                                  <td style={{ textAlign: 'right' }}>
                                    <button
                                      type="button"
                                      className={`btn-small ${isSelected ? 'btn-primary' : 'btn-outline'}`}
                                      style={{ padding: '2px 8px', fontSize: '0.74rem' }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedPayloadId(item.id);
                                      }}
                                    >
                                      {isSelected ? 'Viewing' : 'Inspect'}
                                    </button>
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
              )}
            </div>
          </div>
        </div>
      )}

      {/* GitHub-style Delete Device Confirmation Modal */}
      {deleteConfirmDevice && (
        <div className="device-modal-overlay" onClick={() => !deletingDevice && setDeleteConfirmDevice(null)}>
          <div
            className="device-modal-content slide-up"
            style={{ maxWidth: '520px', width: '92%', borderRadius: '14px', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '18px 24px', borderBottom: '1px solid #fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fef2f2' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626' }}>
                  <FaExclamationTriangle size={18} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#991b1b' }}>
                    Delete Device
                  </h3>
                  <span style={{ fontSize: '0.78rem', color: '#b91c1c' }}>
                    Irreversible Registry Action
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !deletingDevice && setDeleteConfirmDevice(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}
              >
                <FaTimes size={16} />
              </button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              <p style={{ margin: '0 0 14px 0', fontSize: '0.94rem', color: '#334155', lineHeight: 1.5 }}>
                Are you sure want to delete device{' '}
                <strong style={{ color: '#0f172a', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>
                  {deleteConfirmDevice.thingName}
                </strong>{' '}
                assigned at{' '}
                <strong style={{ color: '#0f172a' }}>
                  {deleteConfirmDevice.gate
                    ? `${deleteConfirmDevice.gate.lcNumber} (${deleteConfirmDevice.gate.locationName})`
                    : 'N/A (if assigned nowhere)'}
                </strong>{' '}
                ?
              </p>

              <div style={{ background: '#fffbeb', border: '1px solid #fef3c7', borderRadius: '8px', padding: '12px 14px', marginBottom: '18px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <FaInfoCircle size={15} style={{ color: '#d97706', marginTop: 2, flexShrink: 0 }} />
                <span style={{ fontSize: '0.82rem', color: '#92400e', lineHeight: 1.4 }}>
                  This will permanently delete this device from the registry and remove its historic telemetry logs and scope group assignments. This action cannot be undone.
                </span>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                  To confirm, type <strong style={{ color: '#0f172a' }}>{deleteConfirmDevice.thingName}</strong> below:
                </label>
                <input
                  type="text"
                  className="form-control"
                  style={{ width: '100%', padding: '9px 12px', fontSize: '0.9rem', borderRadius: 6, border: '1px solid #cbd5e1' }}
                  placeholder={`Type ${deleteConfirmDevice.thingName} to confirm`}
                  value={deleteConfirmInput}
                  onChange={(e) => setDeleteConfirmInput(e.target.value)}
                  disabled={deletingDevice}
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button
                  type="button"
                  className="btn-outline"
                  style={{ padding: '8px 16px', fontSize: '0.88rem' }}
                  onClick={() => setDeleteConfirmDevice(null)}
                  disabled={deletingDevice}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={{
                    padding: '8px 18px',
                    fontSize: '0.88rem',
                    fontWeight: 700,
                    background: deleteConfirmInput === deleteConfirmDevice.thingName ? '#dc2626' : '#f87171',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: deleteConfirmInput === deleteConfirmDevice.thingName && !deletingDevice ? 'pointer' : 'not-allowed',
                    opacity: deleteConfirmInput === deleteConfirmDevice.thingName && !deletingDevice ? 1 : 0.6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  disabled={deleteConfirmInput !== deleteConfirmDevice.thingName || deletingDevice}
                  onClick={handleDeleteDevice}
                >
                  <FaTrash size={12} />
                  <span>{deletingDevice ? 'Deleting...' : 'I understand the consequences, delete this device'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
