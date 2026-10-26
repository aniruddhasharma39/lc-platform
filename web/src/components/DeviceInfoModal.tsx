import { useState, useEffect, useCallback } from 'react';
import { 
  FaMicrochip, FaTimes, FaCheck, FaCopy, FaTable, FaCode, 
  FaSyncAlt, FaFileAlt, FaBroadcastTower, FaCogs, FaTools
} from 'react-icons/fa';
import { API_URL } from '../config';
import './DeviceInfoModal.css';

interface DeviceInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  gate?: any;
  master?: any;
  device?: any;
}

/**
 * Renders a clean 2-column key-value table for any manifest object
 */
function RenderParamTable({ data }: { data: Record<string, any> }) {
  const entries = Object.entries(data).filter(([_, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;

  return (
    <div className="dim-table-wrap">
      <table className="dim-table">
        <thead>
          <tr>
            <th style={{ width: '35%' }}>Parameter Key</th>
            <th>Reported Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, val]) => {
            const isObj = typeof val === 'object' && val !== null;
            return (
              <tr key={key}>
                <td className="dim-param-key">
                  <code>{key}</code>
                </td>
                <td className="dim-param-val">
                  {isObj ? (
                    <pre className="dim-inline-json">{JSON.stringify(val, null, 2)}</pre>
                  ) : (
                    <span>{String(val)}</span>
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

/**
 * DeviceInfoModal: Displays dynamic firmware & hardware manifest received from edge device / AWS IoT Core
 * Strictly shows only reported data from /manifest without predefined or hardcoded mock fields.
 */
export default function DeviceInfoModal({ isOpen, onClose, gate, master, device }: DeviceInfoModalProps) {
  const targetDevice = device || 
    (master?.deviceRegistries && master.deviceRegistries[0]) || 
    (gate?.deviceRegistries && gate.deviceRegistries[0]) || 
    master || 
    gate;

  const [loading, setLoading] = useState<boolean>(true);
  const [manifestRecord, setManifestRecord] = useState<any | null>(null);
  const [manifestPayload, setManifestPayload] = useState<any | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');
  const [copied, setCopied] = useState<boolean>(false);

  const thingName = targetDevice?.thingName || targetDevice?.serialNumber || targetDevice?.lcNumber || 'Unknown Device';

  const fetchManifestPayload = useCallback(async () => {
    if (!targetDevice) return;
    setLoading(true);

    try {
      const deviceId = targetDevice.id || targetDevice.thingName || targetDevice.serialNumber;
      if (deviceId) {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/v1/devices/${deviceId}/telemetry`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (res.ok) {
          const data = await res.json();
          if (data.latestManifest?.payload) {
            setManifestRecord(data.latestManifest);
            setManifestPayload(data.latestManifest.payload);
            setLoading(false);
            return;
          }
        }
      }

      // Priority 2: In-memory device metadata from registration
      const meta = targetDevice.metadata?.rawPayload ||
        (targetDevice.metadata?.thing ? targetDevice.metadata : null) ||
        (targetDevice.metadata?.originalEvent ? targetDevice.metadata.originalEvent : null);

      if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
        setManifestRecord({
          topic: `lc/devices/${thingName}/manifest`,
          payload: meta,
          receivedAt: targetDevice.createdAt || targetDevice.updatedAt
        });
        setManifestPayload(meta);
        setLoading(false);
        return;
      }

      // Priority 3: Check targetDevice.attributes for manifest structures
      const attrs = targetDevice.attributes;
      if (attrs && typeof attrs === 'object' && Object.keys(attrs).length > 0) {
        if (attrs.thing || attrs.Master || attrs.hardware || attrs.firmware) {
          setManifestRecord({
            topic: `lc/devices/${thingName}/manifest`,
            payload: attrs,
            receivedAt: targetDevice.updatedAt || targetDevice.createdAt
          });
          setManifestPayload(attrs);
          setLoading(false);
          return;
        }
      }

      // No manifest payload found
      setManifestRecord(null);
      setManifestPayload(null);
    } catch (err) {
      console.error('Error fetching manifest payload:', err);
      // Fallback to local properties if present
      const fallbackPayload = targetDevice.metadata?.rawPayload || targetDevice.attributes?.thing || null;
      if (fallbackPayload) {
        setManifestRecord({ topic: `lc/devices/${thingName}/manifest`, payload: fallbackPayload });
        setManifestPayload(fallbackPayload);
      } else {
        setManifestRecord(null);
        setManifestPayload(null);
      }
    } finally {
      setLoading(false);
    }
  }, [targetDevice, thingName]);

  useEffect(() => {
    if (isOpen) {
      fetchManifestPayload();
    }
  }, [isOpen, fetchManifestPayload]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (!manifestPayload) return;
    navigator.clipboard.writeText(JSON.stringify(manifestPayload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Extract structured sections if present in the real payload
  const payload = manifestPayload || {};

  // Case 1: Spec structure
  const hardware = typeof payload.hardware === 'object' && payload.hardware !== null ? payload.hardware : null;
  const firmware = typeof payload.firmware === 'object' && payload.firmware !== null ? payload.firmware : null;
  const manufacturing = typeof payload.manufacturing === 'object' && payload.manufacturing !== null ? payload.manufacturing : null;
  const runtimeConfig = typeof payload.runtimeConfig === 'object' && payload.runtimeConfig !== null ? payload.runtimeConfig : null;
  const sensors = Array.isArray(payload.sensors) ? payload.sensors : null;
  const components = Array.isArray(payload.components) ? payload.components : null;

  // Case 2: thing.Master or Master structure
  const masterObj = payload.thing?.Master || payload.Master || null;
  const slaveObj = masterObj?.Slave || payload.Slave || null;

  // Remaining keys not represented in the specialized cards
  const recognizedKeys = new Set([
    'hardware', 'firmware', 'manufacturing', 'runtimeConfig', 
    'sensors', 'components', 'thing', 'Master', 'Slave'
  ]);
  const leftoverKeys: Record<string, any> = {};
  Object.entries(payload).forEach(([k, v]) => {
    if (!recognizedKeys.has(k) && v !== undefined && v !== null) {
      leftoverKeys[k] = v;
    }
  });
  const hasLeftovers = Object.keys(leftoverKeys).length > 0;

  return (
    <div className="dim-overlay" onClick={onClose}>
      <div className="dim-modal scale-in" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="dim-header">
          <div className="dim-title-group">
            <div className="dim-icon-wrap">
              <FaMicrochip />
            </div>
            <div>
              <h3 className="dim-title">
                Device Info: <span>{thingName}</span>
              </h3>
              <div className="dim-subtitle">
                Hardware & Firmware Configuration Manifest
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {manifestPayload && (
              <div className="dim-toggle-group">
                <button
                  type="button"
                  className={`dim-view-btn ${viewMode === 'formatted' ? 'active' : ''}`}
                  onClick={() => setViewMode('formatted')}
                >
                  <FaTable size={12} />
                  <span>Formatted</span>
                </button>
                <button
                  type="button"
                  className={`dim-view-btn ${viewMode === 'raw' ? 'active' : ''}`}
                  onClick={() => setViewMode('raw')}
                >
                  <FaCode size={12} />
                  <span>Raw JSON</span>
                </button>
              </div>
            )}

            <button 
              type="button" 
              className="dim-close-btn" 
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              <FaTimes size={16} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="dim-body">
          {loading ? (
            <div className="dim-empty-state">
              <FaSyncAlt className="fa-spin" style={{ fontSize: '1.8rem', color: 'var(--primary)', marginBottom: '0.75rem' }} />
              <h4>Loading Manifest from AWS IoT / RDS...</h4>
              <p>Fetching dynamic hardware specifications and sensor inventory.</p>
            </div>
          ) : !manifestPayload ? (
            /* Honest Empty State when edge device hasn't published manifest */
            <div className="dim-empty-state">
              <FaFileAlt size={42} color="#94a3b8" style={{ marginBottom: '1rem' }} />
              <h4>No Manifest Payload Received Yet</h4>
              <p>
                This device has not yet transmitted its firmware & hardware manifest to:
              </p>
              <code className="dim-code-topic">
                lc/devices/{thingName}/manifest
              </code>
              <p style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: '#64748b' }}>
                Per LC-Platform specifications, only actual payloads received from the device or AWS IoT Core are displayed here — no static placeholders or mock profiles are assumed.
              </p>
              <button 
                type="button" 
                className="btn-outline flex items-center gap-2" 
                style={{ marginTop: '1rem', padding: '6px 14px', fontSize: '0.84rem' }}
                onClick={fetchManifestPayload}
              >
                <FaSyncAlt size={12} />
                <span>Check Again</span>
              </button>
            </div>
          ) : viewMode === 'raw' ? (
            /* RAW JSON VIEW */
            <div className="dim-json-view">
              <div className="dim-json-toolbar">
                <div style={{ fontSize: '0.82rem', color: '#64748b', fontWeight: 600 }}>
                  Topic: <code>{manifestRecord?.topic || `lc/devices/${thingName}/manifest`}</code>
                </div>
                <button type="button" className="dim-copy-btn" onClick={handleCopy}>
                  {copied ? <FaCheck color="#10b981" /> : <FaCopy />}
                  <span>{copied ? 'Copied' : 'Copy JSON'}</span>
                </button>
              </div>
              <pre className="dim-json-box">
                {JSON.stringify(manifestPayload, null, 2)}
              </pre>
            </div>
          ) : (
            /* FORMATTED VIEW: Clean presentation of the received payload */
            <div className="dim-content-flow">
              {/* Manifest Metadata Banner */}
              <div className="dim-manifest-meta">
                <div>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
                    Reported Over MQTT Topic
                  </div>
                  <code style={{ fontSize: '0.86rem', color: '#0369a1', fontWeight: 600 }}>
                    {manifestRecord?.topic || `lc/devices/${thingName}/manifest`}
                  </code>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {manifestRecord?.receivedAt && (
                    <div style={{ textAlign: 'right', fontSize: '0.78rem', color: '#475569' }}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: 700 }}>Received At</span>
                      {new Date(manifestRecord.receivedAt).toLocaleString()}
                    </div>
                  )}
                  <button type="button" className="dim-copy-btn" onClick={handleCopy} title="Copy raw JSON payload">
                    {copied ? <FaCheck color="#10b981" /> : <FaCopy />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>

              {/* 1. MASTER GATEWAY PROFILE (If thing.Master or Master exists) */}
              {masterObj && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaBroadcastTower style={{ color: 'var(--primary, #0b3c7a)', fontSize: '1.1rem' }} />
                    <h4>Master Gateway Profile</h4>
                    <span className="dim-badge master">Primary Thing</span>
                  </div>
                  <RenderParamTable 
                    data={{
                      'Serial Number': masterObj['S.No.'] || masterObj['S.No'] || masterObj.serialNumber,
                      'Device Name': masterObj['Device_Name'] || masterObj.deviceName,
                      'Description': masterObj['Desc'] || masterObj.description,
                      'Date of Mfg': masterObj['Mfg'] || masterObj.mfg || masterObj.dateOfMfg,
                      'Firmware Version': masterObj.version || masterObj.firmwareVersion,
                    }} 
                  />

                  {/* Sub-assemblies / Slaves inside Master */}
                  {slaveObj && (
                    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #f1f5f9' }}>
                      <span className="dim-sensors-title">Reported Barrier Sensors / Slaves</span>
                      <RenderParamTable data={typeof slaveObj === 'object' ? slaveObj : { slave: slaveObj }} />
                    </div>
                  )}
                </div>
              )}

              {/* 2. HARDWARE SPECIFICATIONS */}
              {hardware && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaMicrochip style={{ color: '#0369a1', fontSize: '1.1rem' }} />
                    <h4>Hardware Specifications</h4>
                    {hardware.version && <span className="dim-badge wired">{hardware.version}</span>}
                  </div>
                  <RenderParamTable data={hardware} />
                </div>
              )}

              {/* 3. FIRMWARE PROFILE */}
              {firmware && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaCogs style={{ color: '#059669', fontSize: '1.1rem' }} />
                    <h4>Firmware Profile</h4>
                    {firmware.version && <span className="dim-badge master">{firmware.version}</span>}
                  </div>
                  <RenderParamTable data={firmware} />
                </div>
              )}

              {/* 4. MANUFACTURING DETAILS */}
              {manufacturing && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaTools style={{ color: '#7c3aed', fontSize: '1.1rem' }} />
                    <h4>Manufacturing Profile</h4>
                  </div>
                  <RenderParamTable data={manufacturing} />
                </div>
              )}

              {/* 5. RUNTIME CONFIGURATION */}
              {runtimeConfig && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaCogs style={{ color: '#d97706', fontSize: '1.1rem' }} />
                    <h4>Runtime Configuration</h4>
                  </div>
                  <RenderParamTable data={runtimeConfig} />
                </div>
              )}

              {/* 6. CONFIGURED SENSORS TABLE */}
              {sensors && sensors.length > 0 && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaBroadcastTower style={{ color: '#0284c7', fontSize: '1.1rem' }} />
                    <h4>Configured Sensors ({sensors.length})</h4>
                  </div>
                  <div className="dim-table-wrap">
                    <table className="dim-table">
                      <thead>
                        <tr>
                          <th>Sensor Name / ID</th>
                          <th>Type</th>
                          <th>Pin / Interface</th>
                          <th>Unit / Range</th>
                          <th>Cal Factor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sensors.map((s: any, idx: number) => (
                          <tr key={s.id || idx}>
                            <td style={{ fontWeight: 600, color: '#0f172a' }}>
                              {s.name || s.id || `Sensor ${idx + 1}`}
                            </td>
                            <td>
                              <span className="dim-badge wired" style={{ fontSize: '0.72rem' }}>
                                {s.type || 'SENSOR'}
                              </span>
                            </td>
                            <td>
                              <code>{s.pin || s.interface || s.address || '—'}</code>
                            </td>
                            <td>
                              {s.unit ? `${s.unit} (${s.range || 'N/A'})` : s.range || '—'}
                            </td>
                            <td>
                              {s.calFactor !== undefined ? s.calFactor : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 7. HARDWARE COMPONENTS TABLE */}
              {components && components.length > 0 && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaTools style={{ color: '#6366f1', fontSize: '1.1rem' }} />
                    <h4>Hardware Components ({components.length})</h4>
                  </div>
                  <div className="dim-table-wrap">
                    <table className="dim-table">
                      <thead>
                        <tr>
                          <th>Component</th>
                          <th>Model</th>
                          <th>Vendor</th>
                          <th>Specification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {components.map((c: any, idx: number) => (
                          <tr key={c.name || idx}>
                            <td style={{ fontWeight: 600, color: '#0f172a' }}>
                              {c.name || `Component ${idx + 1}`}
                            </td>
                            <td>
                              <code>{c.model || '—'}</code>
                            </td>
                            <td>
                              {c.vendor || '—'}
                            </td>
                            <td style={{ fontSize: '0.82rem', color: '#475569' }}>
                              {c.spec || c.description || (c.sensors ? `${c.sensors.length} sensors` : '—')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 8. OTHER REPORTED MANIFEST PARAMETERS */}
              {hasLeftovers && (
                <div className="dim-card">
                  <div className="dim-card-header">
                    <FaFileAlt style={{ color: '#475569', fontSize: '1.1rem' }} />
                    <h4>Additional Reported Manifest Parameters</h4>
                  </div>
                  <RenderParamTable data={leftoverKeys} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
