import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { 
  FaMicrochip, FaServer, FaCheckCircle, FaSearch, FaSyncAlt, 
  FaTimes, FaSlidersH, FaBroadcastTower, FaCopy, FaCheck,
  FaTable, FaCode, FaHeartbeat, FaFileAlt, FaPaperPlane, FaDownload
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
  const [autoRefreshTelemetry, setAutoRefreshTelemetry] = useState<boolean>(true);
  const [telemetryViewMode, setTelemetryViewMode] = useState<'table' | 'raw'>('table');
  const [triggeringHealthCheck, setTriggeringHealthCheck] = useState<boolean>(false);

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

  // Open Inspect Modal
  const handleOpenInspect = async (device: DeviceItem) => {
    setInspectDevice(device);
    setSelectedPayloadId(null);
    setInspectTab('telemetry');
    await loadDeviceTelemetry(device, false);
  };

  // Trigger health check command over AWS IoT MQTT
  const handleTriggerHealthCheck = async () => {
    if (!inspectDevice) return;
    setTriggeringHealthCheck(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/devices/${inspectDevice.id}/health-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      });
      const data = await res.json();
      if (res.ok) {
        toastSuccess(`Command published to MQTT topic ${data.topic || 'AWS IoT Core'}`, 'Health Check Sent');
        await loadDeviceTelemetry(inspectDevice, true);
        setInspectTab('health');
      } else {
        toastError(data.error || 'Failed to trigger health check', 'Health Check');
      }
    } catch (err: any) {
      toastError(err.message || 'Error triggering health check', 'Health Check');
    } finally {
      setTriggeringHealthCheck(false);
    }
  };

  // Live Auto-Refresh polling every 3s
  useEffect(() => {
    if (!inspectDevice || !autoRefreshTelemetry) return;
    const interval = setInterval(() => {
      loadDeviceTelemetry(inspectDevice, true);
    }, 3000);
    return () => clearInterval(interval);
  }, [inspectDevice, autoRefreshTelemetry, loadDeviceTelemetry]);

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
      (t.topic && t.topic.includes('/telemetry')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).Status !== undefined || (t.payload as any).LimitSwitchClosed !== undefined))
    );
  }, [historicPayloads]);

  const manifestRecords = useMemo(() => {
    return historicPayloads.filter(t => 
      (t.topic && t.topic.includes('/manifest')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
    );
  }, [historicPayloads]);

  const healthRecords = useMemo(() => {
    return historicPayloads.filter(t => 
      (t.topic && t.topic.includes('/health')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK' || (t.payload as any).NetworkStrength !== undefined || (t.payload as any).BatteryPercentage !== undefined))
    );
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
      {/* Header */}
      <div className="device-registry-header">
        <div>
          <h1 className="device-registry-title">Device Registry</h1>
          <p className="device-registry-subtitle">
            Authenticated AWS IoT Master Units and their hardwired barrier sensor sub-assemblies.
          </p>
        </div>
        <div className="device-registry-header-actions">
          <button 
            type="button" 
            className="btn-outline flex items-center gap-2" 
            onClick={() => fetchDevices(false)} 
            disabled={loading}
          >
            <FaSyncAlt className={loading ? 'fa-spin' : ''} size={13} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

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

                    {/* Actions: Device Info & Inspect */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <button 
                          type="button" 
                          className="btn-small btn-primary flex items-center gap-1.5"
                          style={{ padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer' }}
                          onClick={() => setSelectedDeviceInfo(device)}
                        >
                          <FaMicrochip size={12} /> Device Info
                        </button>

                        <button 
                          type="button" 
                          className="btn-small btn-outline flex items-center gap-1.5"
                          style={{ padding: '6px 12px', fontSize: '0.82rem', cursor: 'pointer' }}
                          onClick={() => handleOpenInspect(device)}
                        >
                          <FaSlidersH size={12} /> Inspect
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
            <div className="device-modal-header flex justify-between items-center pb-3 border-b">
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800 }}>
                    {inspectDevice.thingName}
                  </h2>
                  <span className="badge badge-indigo" style={{ fontSize: '0.78rem', padding: '3px 9px' }}>
                    AWS IoT Core
                  </span>
                  {inspectDevice.gate && (
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#475569' }}>
                      {inspectDevice.gate.lcNumber} • {inspectDevice.gate.locationName}
                    </span>
                  )}
                  <span className={`status-pill ${inspectDevice.computedStatus === 'ONLINE' ? 'online' : 'offline'}`}>
                    <span className={inspectDevice.computedStatus === 'ONLINE' ? 'pulse-dot' : 'status-dot'} style={{ width: 7, height: 7 }} />
                    {inspectDevice.computedStatus === 'ONLINE' ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Auto Refresh Toggle */}
                <button
                  type="button"
                  className={`btn-small ${autoRefreshTelemetry ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: '0.78rem', padding: '5px 11px', display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setAutoRefreshTelemetry(!autoRefreshTelemetry)}
                  title="Toggle automatic live polling every 3 seconds"
                >
                  <span className={autoRefreshTelemetry ? 'pulse-dot' : ''} style={{ width: 6, height: 6 }} />
                  {autoRefreshTelemetry ? 'Auto Polling (3s)' : 'Polling Paused'}
                </button>

                {/* Useful Action 1: Manual Refresh */}
                <button
                  type="button"
                  className="btn-small btn-outline flex items-center gap-1.5"
                  style={{ fontSize: '0.78rem', padding: '5px 10px', height: '30px' }}
                  onClick={() => loadDeviceTelemetry(inspectDevice, false)}
                  disabled={loadingHistory}
                  title="Fetch latest telemetry and manifest records"
                >
                  <FaSyncAlt className={loadingHistory ? 'fa-spin' : ''} size={11} />
                  <span>{loadingHistory ? 'Syncing...' : 'Refresh'}</span>
                </button>

                {/* Useful Action 2: Trigger Health Check / Ping Device */}
                <button
                  type="button"
                  className="btn-small btn-outline flex items-center gap-1.5"
                  style={{ fontSize: '0.78rem', padding: '5px 10px', height: '30px', color: '#0b3c7a', borderColor: '#bfdbfe' }}
                  onClick={handleTriggerHealthCheck}
                  disabled={triggeringHealthCheck}
                  title="Publish MQTT Health Check ping to device via AWS IoT Core"
                >
                  <FaHeartbeat className={triggeringHealthCheck ? 'fa-spin' : ''} size={12} color="#dc2626" />
                  <span>{triggeringHealthCheck ? 'Pinging...' : 'Ping Device'}</span>
                </button>

                {/* Useful Action 3: Export Records as JSON */}
                <button
                  type="button"
                  className="btn-small btn-outline flex items-center gap-1.5"
                  style={{ fontSize: '0.78rem', padding: '5px 10px', height: '30px' }}
                  onClick={() => {
                    const exportData = {
                      device: inspectDevice,
                      telemetrySummary,
                      historyCount: historicPayloads.length,
                      records: historicPayloads,
                      exportedAt: new Date().toISOString()
                    };
                    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${inspectDevice.thingName}-telemetry-export.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    toastSuccess('Telemetry & manifest records exported as JSON', 'Export Successful');
                  }}
                  title="Export telemetry records to a JSON file"
                >
                  <FaDownload size={11} />
                  <span>Export</span>
                </button>

                {/* Modal Close Button */}
                <button 
                  type="button" 
                  onClick={() => setInspectDevice(null)}
                  style={{
                    width: '30px',
                    height: '30px',
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

              {/* View Format Toggle (Organized Table vs Raw JSON) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ background: '#f1f5f9', padding: '2px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex' }}>
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
                    style={{ fontSize: '0.75rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 5 }}
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
                        {currentViewingRecord?.payload?.Status && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: '0.8rem', color: '#475569', fontWeight: 600 }}>Gate Status:</span>
                            <span
                              style={{
                                padding: '4px 14px',
                                borderRadius: '6px',
                                fontWeight: 800,
                                fontSize: '0.9rem',
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

                      {/* Selected Telemetry Payload Presentation */}
                      {currentViewingRecord ? (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="flex justify-between items-center mb-2">
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e293b' }}>
                              Payload Breakdown (Recorded {new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                            </span>
                            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                              {new Date(currentViewingRecord.receivedAt).toLocaleDateString()}
                            </span>
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
                                      key={item.id || idx}
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
                        <p style={{ margin: '4px 0 0 0', fontSize: '0.8rem', color: '#475569' }}>
                          Transmitted by edge device firmware upon boot or commissioning with configured sensors and hardware identifiers.
                        </p>
                      </div>

                      {currentViewingRecord ? (
                        <div>
                          <div className="flex justify-between items-center mb-2">
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e293b' }}>
                              Configuration & Hardware Manifest
                            </span>
                            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                              {new Date(currentViewingRecord.receivedAt).toLocaleString()}
                            </span>
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
                      {/* Health Check Trigger Action Banner */}
                      <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '1rem', marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FaHeartbeat color="#16a34a" size={18} />
                            <h4 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: '#166534' }}>
                              On-Demand Device Health Diagnostic
                            </h4>
                          </div>
                          <p style={{ margin: '4px 0 0 0', fontSize: '0.82rem', color: '#15803d', maxWidth: '620px' }}>
                            Triggering a health check sends an MQTT command to topic <code>lc-gate/{inspectDevice.thingName}/health/request</code>. 
                            The edge device tests connectivity, reads active sensors, and responds on <code>lc-gate/{inspectDevice.thingName}/health</code>.
                          </p>
                        </div>

                        <button
                          type="button"
                          className="btn-primary flex items-center gap-2"
                          style={{ padding: '8px 18px', fontSize: '0.85rem', fontWeight: 700 }}
                          onClick={handleTriggerHealthCheck}
                          disabled={triggeringHealthCheck}
                        >
                          <FaPaperPlane size={12} />
                          {triggeringHealthCheck ? 'Publishing Command...' : 'Trigger Health Check'}
                        </button>
                      </div>

                      {/* Latest Health Check Response */}
                      {currentViewingRecord ? (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="flex justify-between items-center mb-2">
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e293b' }}>
                              Health Check Payload (Recorded {new Date(currentViewingRecord.receivedAt).toLocaleTimeString()})
                            </span>
                            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                              Topic: <code>{currentViewingRecord.topic || `lc-gate/${inspectDevice.thingName}/health`}</code>
                            </span>
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
                                      key={item.id || idx}
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
                          <div className="flex justify-between items-center mb-2">
                            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#1e293b' }}>
                              Selected Payload ({currentViewingRecord.topic})
                            </span>
                            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                              {new Date(currentViewingRecord.receivedAt).toLocaleString()}
                            </span>
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
                                  key={item.id || idx}
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

    </div>
  );
}
