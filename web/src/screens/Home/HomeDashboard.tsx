import { useEffect, useState, useRef } from 'react';
import {
  FaArchway,
  FaSyncAlt,
  FaSun,
  FaHistory,
  FaChevronLeft,
  FaChevronRight,
  FaClock,
  FaExternalLinkAlt,
  FaDoorOpen,
  FaDoorClosed,
  FaExclamationTriangle,
} from 'react-icons/fa';
import type { User } from '../../types';
import { API_URL } from '../../config';

interface GateSummaryItem {
  id: number;
  lcNumber: string;
  name: string;
  locationName: string;
  zone: string;
  division: string;
  latitude: number | null;
  longitude: number | null;
  powerSource: 'SOLAR' | 'DIRECT';
  status: 'OPEN' | 'CLOSED';
  todayCycles: number;
  totalCycles: number;
  lastClosedAt: string | null;
  lastClosedFormatted: string;
  masterSerialNumber: string;
  mastersCount: number;
  slavesCount: number;
  scopeGroupId: number | null;
  scopeGroupName: string | null;
  scopeGroupColor: string | null;
}

interface DashboardSummaryData {
  totalDevices: number;
  totalCyclesToday: number;
  totalOpenGates: number;
  totalClosedGates: number;
  gates: GateSummaryItem[];
}

interface HomeDashboardProps {
  user: User;
  onNavigateToGate: (gateId: number, tab?: 'about' | 'telemetry') => void;
  onNavigateToModule?: (slug: string) => void;
}

export default function HomeDashboard({
  user,
  onNavigateToGate,
}: HomeDashboardProps) {
  const [data, setData] = useState<DashboardSummaryData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeGateId, setActiveGateId] = useState<number | null>(null);

  const sliderRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<Map<number, any>>(new Map());

  const fetchSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/lcgates/dashboard-summary`, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to load dashboard summary (HTTP ${res.status})`);
      }
      const json = await res.json();
      setData(json);
      if (json.gates && json.gates.length > 0 && !activeGateId) {
        setActiveGateId(json.gates[0].id);
      }
    } catch (err: any) {
      console.error('Dashboard summary fetch error:', err);
      setError(err.message || 'Unable to load dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  // Initialize and update Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Check if Leaflet window.L is loaded
    const L = (window as any).L;
    if (!L) {
      console.warn('Leaflet (window.L) is not loaded yet');
      return;
    }

    if (!mapInstanceRef.current) {
      // Create map centered on India
      const map = L.map(mapContainerRef.current, {
        center: [22.9734, 78.6569], // Central India
        zoom: 5,
        minZoom: 4,
        maxZoom: 18,
        scrollWheelZoom: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      mapInstanceRef.current = map;
    }

    const map = mapInstanceRef.current;
    if (!map) return;

    // Clear existing markers
    markersRef.current.forEach((marker) => {
      marker.remove();
    });
    markersRef.current.clear();

    const gatesWithGps = (data?.gates || []).filter(
      (g) => g.latitude !== null && g.longitude !== null && !isNaN(g.latitude) && !isNaN(g.longitude)
    );

    const bounds: any[] = [];

    gatesWithGps.forEach((gate) => {
      const lat = gate.latitude!;
      const lng = gate.longitude!;
      bounds.push([lat, lng]);

      const isOpen = gate.status === 'OPEN';
      const statusColor = isOpen ? '#ef4444' : '#10b981';
      const statusBg = isOpen ? '#fef2f2' : '#ecfdf5';

      // Custom HTML Marker Icon
      const customIcon = L.divIcon({
        className: 'custom-gate-pin',
        html: `
          <div style="
            display: flex;
            align-items: center;
            justify-content: center;
            background: #ffffff;
            border: 2.5px solid ${statusColor};
            border-radius: 20px;
            padding: 4px 10px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transform: translate(-50%, -50%);
          ">
            <span style="
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background: ${statusColor};
              margin-right: 6px;
              display: inline-block;
            "></span>
            <strong style="font-size: 11px; color: #0f172a; letter-spacing: 0.5px;">${gate.masterSerialNumber}</strong>
          </div>
        `,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });

      const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);

      // Popup Content
      const popupHtml = `
        <div style="font-family: inherit; min-width: 200px; padding: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
            <strong style="font-size: 14px; color: #0f172a;">${gate.masterSerialNumber}</strong>
            <span style="
              padding: 2px 8px;
              border-radius: 12px;
              font-size: 10px;
              font-weight: 800;
              background: ${statusBg};
              color: ${statusColor};
              border: 1px solid ${statusColor}40;
            ">${gate.status}</span>
          </div>
          <div style="font-size: 12px; color: #475569; margin-bottom: 4px;">
            📍 <strong>${gate.locationName}</strong> (${gate.zone})
          </div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">
            🔄 <strong>${gate.todayCycles}</strong> cycles today • Last: ${gate.lastClosedFormatted}
          </div>
          <div style="display: flex; gap: 6px;">
            <button id="btn-inspect-${gate.id}" style="
              flex: 1;
              background: #0284c7;
              color: #ffffff;
              border: none;
              padding: 6px 8px;
              border-radius: 6px;
              font-size: 11px;
              font-weight: 600;
              cursor: pointer;
            ">Inspect Telemetry</button>
            <button id="btn-about-${gate.id}" style="
              flex: 1;
              background: #f1f5f9;
              color: #334155;
              border: 1px solid #cbd5e1;
              padding: 6px 8px;
              border-radius: 6px;
              font-size: 11px;
              font-weight: 600;
              cursor: pointer;
            ">About</button>
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);

      marker.on('popupopen', () => {
        const btnInspect = document.getElementById(`btn-inspect-${gate.id}`);
        if (btnInspect) {
          btnInspect.onclick = () => onNavigateToGate(gate.id, 'telemetry');
        }
        const btnAbout = document.getElementById(`btn-about-${gate.id}`);
        if (btnAbout) {
          btnAbout.onclick = () => onNavigateToGate(gate.id, 'about');
        }
      });

      markersRef.current.set(gate.id, marker);
    });

    // Fit map bounds if there are markers, or default to India center
    if (bounds.length > 0) {
      if (bounds.length === 1) {
        map.setView(bounds[0], 12);
      } else {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
      }
    } else {
      map.setView([22.9734, 78.6569], 5);
    }
  }, [data]);

  const handleCardClick = (gate: GateSummaryItem) => {
    setActiveGateId(gate.id);
    if (gate.latitude && gate.longitude && mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([gate.latitude, gate.longitude], 13, { duration: 1.2 });
      const marker = markersRef.current.get(gate.id);
      if (marker) {
        marker.openPopup();
      }
    }
  };

  const scrollSlider = (direction: 'left' | 'right') => {
    if (!sliderRef.current) return;
    const distance = 340;
    sliderRef.current.scrollBy({
      left: direction === 'left' ? -distance : distance,
      behavior: 'smooth',
    });
  };

  const roleName = typeof user.role === 'object' ? (user.role as any)?.name : user.role;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40 }}>
      {/* Welcome & Role Context Banner */}
      <div
        className="card"
        style={{
          padding: '20px 24px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#ffffff',
          borderRadius: 14,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          boxShadow: '0 4px 20px rgba(15, 23, 42, 0.15)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: '#ffffff' }}>
              Welcome back, {user.fullName}
            </h2>
            <span
              style={{
                background: 'rgba(255,255,255,0.15)',
                color: '#38bdf8',
                padding: '2px 10px',
                borderRadius: 20,
                fontSize: '0.78rem',
                fontWeight: 700,
                letterSpacing: '0.5px',
              }}
            >
              {roleName}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: '0.88rem', color: '#94a3b8' }}>
            Level Crossing Operations & Real-Time Monitoring Dashboard
            {user.scopeGroups && user.scopeGroups.length > 0 && (
              <span style={{ marginLeft: 8, color: '#e2e8f0' }}>
                • Scoped to: <strong>{user.scopeGroups.map((s) => s.name).join(', ')}</strong>
              </span>
            )}
          </p>
        </div>

        <button
          onClick={fetchSummary}
          disabled={loading}
          style={{
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#ffffff',
            borderRadius: 8,
            padding: '8px 14px',
            fontSize: '0.84rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            transition: 'all 0.2s',
          }}
          title="Refresh KPIs"
        >
          <FaSyncAlt className={loading ? 'fa-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            color: '#b91c1c',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: '0.88rem',
          }}
        >
          <FaExclamationTriangle />
          <span>{error}</span>
        </div>
      )}

      {/* KPI Cards Row (4 Metric Tiles) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        {/* KPI 1: Total Devices for Role */}
        <div
          className="card"
          style={{
            padding: '18px 20px',
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            backgroundColor: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 12,
              backgroundColor: '#e0f2fe',
              color: '#0284c7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              flexShrink: 0,
            }}
          >
            <FaArchway />
          </div>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
              Total Assigned Clusters
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#0f172a', lineHeight: 1.2 }}>
              {loading ? '—' : data?.totalDevices ?? 0}
            </div>
            <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>Visible to {roleName} role</div>
          </div>
        </div>

        {/* KPI 2: Total Cycles Today */}
        <div
          className="card"
          style={{
            padding: '18px 20px',
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            backgroundColor: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 12,
              backgroundColor: '#fef3c7',
              color: '#d97706',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              flexShrink: 0,
            }}
          >
            <FaHistory />
          </div>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
              Gate Cycles Today
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#0f172a', lineHeight: 1.2 }}>
              {loading ? '—' : data?.totalCyclesToday ?? 0}
            </div>
            <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>Open/Close operations</div>
          </div>
        </div>

        {/* KPI 3: Currently Open */}
        <div
          className="card"
          style={{
            padding: '18px 20px',
            borderRadius: 12,
            border: '1px solid #fee2e2',
            backgroundColor: '#fffdfd',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            boxShadow: '0 2px 8px rgba(239, 68, 68, 0.05)',
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 12,
              backgroundColor: '#fee2e2',
              color: '#ef4444',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              flexShrink: 0,
            }}
          >
            <FaDoorOpen />
          </div>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#dc2626', textTransform: 'uppercase' }}>
              Currently Opened
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ef4444', lineHeight: 1.2 }}>
              {loading ? '—' : data?.totalOpenGates ?? 0}
            </div>
            <div style={{ fontSize: '0.74rem', color: '#b91c1c' }}>Road traffic stopped</div>
          </div>
        </div>

        {/* KPI 4: Currently Closed */}
        <div
          className="card"
          style={{
            padding: '18px 20px',
            borderRadius: 12,
            border: '1px solid #d1fae5',
            backgroundColor: '#fcfdfd',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            boxShadow: '0 2px 8px rgba(16, 185, 129, 0.05)',
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 12,
              backgroundColor: '#d1fae5',
              color: '#059669',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              flexShrink: 0,
            }}
          >
            <FaDoorClosed />
          </div>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#059669', textTransform: 'uppercase' }}>
              Currently Closed
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#059669', lineHeight: 1.2 }}>
              {loading ? '—' : data?.totalClosedGates ?? 0}
            </div>
            <div style={{ fontSize: '0.74rem', color: '#047857' }}>Safe for train movement</div>
          </div>
        </div>
      </div>

      {/* Transition Card Slider Section */}
      <div className="card" style={{ padding: 20, borderRadius: 14, backgroundColor: '#ffffff' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a', fontWeight: 800 }}>
              Assigned Gate Cycles & Activity Slider
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748b' }}>
              Transition card for each assigned gate showing cycles performed today and timestamp of last closure
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => scrollSlider('left')}
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '1px solid #cbd5e1',
                background: '#ffffff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#334155',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              }}
              title="Scroll Left"
            >
              <FaChevronLeft size={13} />
            </button>
            <button
              onClick={() => scrollSlider('right')}
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: '1px solid #cbd5e1',
                background: '#ffffff',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#334155',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              }}
              title="Scroll Right"
            >
              <FaChevronRight size={13} />
            </button>
          </div>
        </div>

        {/* Scrollable Container */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
            <FaSyncAlt className="fa-spin" size={24} style={{ marginBottom: 12 }} />
            <div>Loading gate cycle metrics...</div>
          </div>
        ) : (data?.gates || []).length === 0 ? (
          <div style={{ padding: 36, textAlign: 'center', color: '#64748b' }}>
            <FaArchway size={36} style={{ color: '#cbd5e1', marginBottom: 10 }} />
            <div style={{ fontWeight: 600 }}>No LC Gates assigned to your role or scope groups.</div>
            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 4 }}>
              Contact your system administrator to assign Railway Scope Groups to your account.
            </div>
          </div>
        ) : (
          <div
            ref={sliderRef}
            style={{
              display: 'flex',
              gap: 16,
              overflowX: 'auto',
              paddingBottom: 10,
              scrollSnapType: 'x mandatory',
              scrollbarWidth: 'thin',
            }}
          >
            {data!.gates.map((gate) => {
              const isOpen = gate.status === 'OPEN';
              const isSelected = activeGateId === gate.id;

              return (
                <div
                  key={gate.id}
                  onClick={() => handleCardClick(gate)}
                  style={{
                    minWidth: 320,
                    maxWidth: 340,
                    flexShrink: 0,
                    scrollSnapAlign: 'start',
                    borderRadius: 12,
                    border: isSelected ? '2px solid #0284c7' : '1px solid #e2e8f0',
                    backgroundColor: isSelected ? '#f0f9ff' : '#ffffff',
                    padding: 16,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    boxShadow: isSelected
                      ? '0 6px 18px rgba(2, 132, 199, 0.18)'
                      : '0 2px 6px rgba(0,0,0,0.04)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  {/* Top Bar: Cluster ID, Status, Power */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            background: '#0f172a',
                            color: '#ffffff',
                            fontWeight: 800,
                            fontSize: '0.85rem',
                            padding: '3px 8px',
                            borderRadius: 6,
                            letterSpacing: '0.5px',
                          }}
                        >
                          {gate.masterSerialNumber}
                        </span>
                        {gate.powerSource === 'SOLAR' && (
                          <span
                            style={{
                              background: '#fef3c7',
                              color: '#b45309',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                            }}
                          >
                            <FaSun size={10} /> Solar
                          </span>
                        )}
                      </div>

                      <span
                        style={{
                          padding: '3px 10px',
                          borderRadius: 20,
                          fontSize: '0.75rem',
                          fontWeight: 800,
                          background: isOpen ? '#fef2f2' : '#ecfdf5',
                          color: isOpen ? '#ef4444' : '#10b981',
                          border: `1px solid ${isOpen ? '#fecaca' : '#a7f3d0'}`,
                        }}
                      >
                        ● {gate.status}
                      </span>
                    </div>

                    {/* Location & Railway Zone */}
                    <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#1e293b', marginBottom: 2 }}>
                      {gate.locationName}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: '#64748b', marginBottom: 12 }}>
                      {gate.zone} • {gate.division} Division
                      {gate.scopeGroupName && (
                        <span style={{ marginLeft: 6, color: gate.scopeGroupColor || '#0284c7', fontWeight: 600 }}>
                          [{gate.scopeGroupName}]
                        </span>
                      )}
                    </div>

                    {/* Highlight Metric: Today's Cycles */}
                    <div
                      style={{
                        background: isSelected ? '#ffffff' : '#f8fafc',
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        padding: '10px 12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <FaHistory style={{ color: '#0284c7', fontSize: '1.1rem' }} />
                        <div>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase' }}>
                            Cycles Today
                          </div>
                          <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#0f172a' }}>
                            {gate.todayCycles} <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>times</span>
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>Total Recorded</div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#475569' }}>
                          {gate.totalCycles} cycles
                        </div>
                      </div>
                    </div>

                    {/* Last Time Closed Metric */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: '0.78rem',
                        color: '#475569',
                        padding: '6px 0',
                      }}
                    >
                      <FaClock style={{ color: '#94a3b8', fontSize: '0.88rem' }} />
                      <div>
                        <span style={{ color: '#64748b' }}>Last Closed:</span>{' '}
                        <strong style={{ color: '#0f172a' }}>{gate.lastClosedFormatted}</strong>
                      </div>
                    </div>
                  </div>

                  {/* Quick Action Navigation Buttons */}
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      marginTop: 14,
                      paddingTop: 10,
                      borderTop: '1px solid #f1f5f9',
                    }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateToGate(gate.id, 'telemetry');
                      }}
                      style={{
                        flex: 1,
                        background: '#0284c7',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '7px 10px',
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                      }}
                    >
                      <span>Telemetry</span>
                      <FaExternalLinkAlt size={10} />
                    </button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigateToGate(gate.id, 'about');
                      }}
                      style={{
                        flex: 1,
                        background: '#f8fafc',
                        color: '#334155',
                        border: '1px solid #cbd5e1',
                        borderRadius: 6,
                        padding: '7px 10px',
                        fontSize: '0.78rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      About Cluster
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Map Section: India LC Gate Clusters Map */}
      <div className="card" style={{ padding: 20, borderRadius: 14, backgroundColor: '#ffffff' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a', fontWeight: 800 }}>
              India LC Gate Clusters Map
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748b' }}>
              Geographic coordinates and live status of clusters layered across the India Railway network
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: '0.78rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} />
              <span style={{ fontWeight: 600, color: '#334155' }}>Closed (Safe)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
              <span style={{ fontWeight: 600, color: '#334155' }}>Opened (Traffic Stopped)</span>
            </div>
          </div>
        </div>

        {/* Leaflet Map Box */}
        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: '460px',
            borderRadius: 10,
            overflow: 'hidden',
            border: '1px solid #e2e8f0',
            boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.06)',
            backgroundColor: '#e5e7eb',
          }}
        />

        <div
          style={{
            marginTop: 10,
            fontSize: '0.76rem',
            color: '#64748b',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>
            Clicking any cluster pin opens telemetry details and allows direct navigation to its full console.
          </span>
          <span>OpenStreetMap &copy; Leaflet</span>
        </div>
      </div>
    </div>
  );
}
