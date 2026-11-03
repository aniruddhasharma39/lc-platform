import React, { useState, useEffect, useRef } from 'react';
import { FaTrain, FaSearch, FaPlus, FaTimes, FaCheck, FaExclamationCircle } from 'react-icons/fa';
import { API_URL } from '../config';
import { stationsForDivision } from '../screens/Cluster/railwayData';

interface Station {
  id?: number;
  code: string;
  name: string;
  division?: string;
  zone?: string;
}

interface StationSearchSelectProps {
  zone: string;
  division: string;
  selectedStationId?: number | string | null;
  selectedStationCode?: string | null;
  onSelectStation: (station: Station | null) => void;
  disabled?: boolean;
}

export default function StationSearchSelect({
  zone,
  division,
  selectedStationId,
  selectedStationCode,
  onSelectStation,
  disabled = false,
}: StationSearchSelectProps) {
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Custom station modal / inline creation state
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [customError, setCustomError] = useState('');
  const [savingCustom, setSavingCustom] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fetch stations whenever division or zone changes
  useEffect(() => {
    if (!division) {
      setStations([]);
      return;
    }

    setLoading(true);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { 'Authorization': `Bearer ${token}` } : {};

    fetch(`${API_URL}/api/v1/lcgate/stations?division=${encodeURIComponent(division)}&zone=${encodeURIComponent(zone || '')}`, {
      headers
    })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setStations(data);
        } else {
          // Fallback to static station dataset
          setStations(stationsForDivision(division));
        }
      })
      .catch(() => {
        setStations(stationsForDivision(division));
      })
      .finally(() => setLoading(false));
  }, [division, zone]);

  // Handle outside click to close dropdown
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowAddCustom(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Determine currently selected station
  const currentStation = stations.find(s => {
    if (selectedStationId && s.id && String(s.id) === String(selectedStationId)) return true;
    if (selectedStationCode && s.code.toUpperCase() === selectedStationCode.toUpperCase()) return true;
    return false;
  });

  // Filter stations based on search query (name or code)
  const filteredStations = stations.filter(s => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
  });

  const handleOpenDropdown = () => {
    if (disabled || !division) return;
    setIsOpen(true);
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 50);
  };

  const handleSelect = (station: Station) => {
    onSelectStation(station);
    setIsOpen(false);
    setSearchQuery('');
    setShowAddCustom(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectStation(null);
    setSearchQuery('');
  };

  const handleCreateCustomStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim() || !customCode.trim()) {
      setCustomError('Both station name and station code are required.');
      return;
    }

    setSavingCustom(true);
    setCustomError('');

    try {
      const cleanCode = customCode.trim().toUpperCase();
      const cleanName = customName.trim();
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/lcgate/stations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          name: cleanName,
          code: cleanCode,
          division: division.trim(),
          zone: (zone || '').trim() || undefined,
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save station');
      }

      const savedStation: Station = await res.json();
      
      // Update local stations list if not already present
      setStations(prev => {
        const exists = prev.some(s => s.code.toUpperCase() === savedStation.code.toUpperCase());
        return exists ? prev : [savedStation, ...prev];
      });

      // Select the newly created station
      onSelectStation(savedStation);
      setShowAddCustom(false);
      setCustomName('');
      setCustomCode('');
      setIsOpen(false);
      setSearchQuery('');
    } catch (err: any) {
      setCustomError(err.message || 'Error creating custom station');
    } finally {
      setSavingCustom(false);
    }
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* Trigger / Display Field */}
      <div
        onClick={handleOpenDropdown}
        style={{
          width: '100%',
          minHeight: '42px',
          padding: '8px 12px',
          borderRadius: '8px',
          border: '1px solid var(--border, #cbd5e1)',
          backgroundColor: disabled || !division ? 'rgba(0,0,0,0.03)' : '#ffffff',
          cursor: disabled || !division ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          boxShadow: isOpen ? '0 0 0 3px rgba(11, 60, 122, 0.15)' : 'none',
          borderColor: isOpen ? 'var(--primary, #0B3C7A)' : 'var(--border, #cbd5e1)',
          transition: 'all 0.15s ease'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <FaTrain style={{ color: currentStation ? 'var(--primary, #0B3C7A)' : '#94a3b8', flexShrink: 0 }} />
          {currentStation ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-main, #0f172a)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {currentStation.name}
              </span>
              <span style={{
                backgroundColor: 'rgba(11, 60, 122, 0.1)',
                color: 'var(--primary, #0B3C7A)',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '0.75rem',
                fontWeight: 700,
                fontFamily: 'monospace'
              }}>
                {currentStation.code}
              </span>
            </div>
          ) : (
            <span style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
              {!division ? 'Select Railway Division first…' : (loading ? 'Loading stations…' : 'Search or select Railway Station…')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {currentStation && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear selection"
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                padding: '3px',
                display: 'flex',
                alignItems: 'center',
                borderRadius: '50%',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
            >
              <FaTimes size={12} />
            </button>
          )}
          <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>▼</span>
        </div>
      </div>

      {/* Dropdown Menu */}
      {isOpen && !disabled && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 1050,
            backgroundColor: '#ffffff',
            borderRadius: '10px',
            border: '1px solid #cbd5e1',
            boxShadow: '0 12px 28px rgba(0,0,0,0.15)',
            maxHeight: '340px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Search Header */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#f8fafc' }}>
            <FaSearch size={13} style={{ color: '#64748b', flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Type station name or code (e.g. ADI, Pune, Viramgam)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                fontSize: '0.85rem',
                color: '#0f172a'
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '2px' }}
              >
                <FaTimes size={11} />
              </button>
            )}
          </div>

          {/* Quick Actions Bar */}
          <div style={{ padding: '6px 10px', backgroundColor: '#f1f5f9', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>
              {filteredStations.length} stations in {division}
            </span>
            <button
              type="button"
              onClick={() => {
                setShowAddCustom(!showAddCustom);
                if (!showAddCustom && searchQuery) {
                  setCustomName(searchQuery.trim());
                  const codeCandidate = searchQuery.trim().replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
                  setCustomCode(codeCandidate);
                }
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--primary, #0B3C7A)',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 4px'
              }}
            >
              <FaPlus size={10} /> {showAddCustom ? 'Hide Custom Entry' : '+ Add Custom Station'}
            </button>
          </div>

          {/* Custom Station Inline Creation Form */}
          {showAddCustom && (
            <div style={{ padding: '12px', backgroundColor: '#eff6ff', borderBottom: '1px solid #bfdbfe' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#1e3a8a', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <FaTrain size={12} /> Add New Station to {division} Division
              </div>
              {customError && (
                <div style={{ fontSize: '0.75rem', color: '#dc2626', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <FaExclamationCircle size={10} /> {customError}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '8px', marginBottom: '8px' }}>
                <input
                  type="text"
                  placeholder="Station Name (e.g. Navagadh)"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  style={{
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.8rem',
                    backgroundColor: '#ffffff'
                  }}
                />
                <input
                  type="text"
                  placeholder="Code (e.g. NVDH)"
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                  style={{
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.8rem',
                    fontFamily: 'monospace',
                    textTransform: 'uppercase',
                    backgroundColor: '#ffffff'
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setShowAddCustom(false)}
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    borderRadius: '5px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#ffffff',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreateCustomStation}
                  disabled={savingCustom || !customName.trim() || !customCode.trim()}
                  style={{
                    padding: '4px 12px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    borderRadius: '5px',
                    border: 'none',
                    backgroundColor: 'var(--primary, #0B3C7A)',
                    color: '#ffffff',
                    cursor: savingCustom ? 'not-allowed' : 'pointer'
                  }}
                >
                  {savingCustom ? 'Saving…' : 'Save & Select'}
                </button>
              </div>
            </div>
          )}

          {/* Station List */}
          <div style={{ overflowY: 'auto', flex: 1, maxHeight: '220px' }}>
            {filteredStations.length === 0 ? (
              <div style={{ padding: '24px 16px', textAlign: 'center', color: '#64748b', fontSize: '0.85rem' }}>
                <div>No stations found matching "<strong>{searchQuery}</strong>".</div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddCustom(true);
                    setCustomName(searchQuery.trim());
                    const codeCandidate = searchQuery.trim().replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
                    setCustomCode(codeCandidate);
                  }}
                  style={{
                    marginTop: '8px',
                    padding: '6px 12px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    borderRadius: '6px',
                    backgroundColor: '#e0f2fe',
                    color: '#0369a1',
                    border: '1px solid #bae6fd',
                    cursor: 'pointer'
                  }}
                >
                  + Add "{searchQuery.trim()}" as New Station
                </button>
              </div>
            ) : (
              filteredStations.map(st => {
                const isSelected = (currentStation?.id && st.id === currentStation.id) || (currentStation?.code && st.code === currentStation.code);
                return (
                  <div
                    key={st.id || st.code}
                    onClick={() => handleSelect(st)}
                    style={{
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid #f8fafc',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? '#f0f9ff' : '#ffffff',
                      transition: 'background-color 0.1s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = '#f8fafc';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = '#ffffff';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '0.88rem', fontWeight: isSelected ? 700 : 500, color: isSelected ? '#0369a1' : '#1e293b' }}>
                        {st.name}
                      </span>
                      <span style={{
                        backgroundColor: '#f1f5f9',
                        color: '#475569',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        fontFamily: 'monospace'
                      }}>
                        {st.code}
                      </span>
                    </div>
                    {isSelected && <FaCheck size={12} style={{ color: '#0284c7' }} />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

