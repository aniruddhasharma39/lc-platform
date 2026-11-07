import { useState, useEffect } from 'react';
import { API_URL } from '../config';
import {
  FaTrain,
  FaShieldAlt,
  FaIdBadge,
  FaBuilding,
  FaUserTie,
  FaExclamationTriangle,
  FaSpinner,
  FaCheckCircle,
  FaUpload
} from 'react-icons/fa';
import { useToast } from '../context/ToastContext';

type Props = {
  onGoToLogin: () => void;
};

interface GateRef {
  id: number;
  lcNumber: string;
  name?: string;
  locationName: string;
}

interface StationRef {
  id: number | null;
  code: string;
  name: string;
  gates: GateRef[];
}

interface DivisionRef {
  name: string;
  stations: StationRef[];
}

interface ZoneRef {
  name: string;
  divisions: DivisionRef[];
}

interface DesignationInfo {
  name: string;
  seniority: number;
  level: 'DIVISIONAL' | 'STATION' | 'GATE';
  maxGates?: number;
  immediateSuperior: string | null;
  description: string;
}

interface DepartmentInfo {
  name: string;
  designations: DesignationInfo[];
}

export default function Register({ onGoToLogin }: Props) {
  const { success: toastSuccess, error: toastError } = useToast();

  // Hierarchy from backend (actual installations only)
  const [zones, setZones] = useState<ZoneRef[]>([]);
  const [departments, setDepartments] = useState<DepartmentInfo[]>([]);
  const [loadingHierarchy, setLoadingHierarchy] = useState(true);

  // Dynamic builder form schema
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [formId, setFormId] = useState<number | null>(null);

  // Form inputs
  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Mobile OTP Verification State
  const [otp, setOtp] = useState('');
  const [isMobileVerified, setIsMobileVerified] = useState(false);
  const [verifiedMobile, setVerifiedMobile] = useState('');
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpResendCountdown, setOtpResendCountdown] = useState(0);

  // ID card file
  const [idCardFile, setIdCardFile] = useState<File | null>(null);
  const [idCardPreview, setIdCardPreview] = useState<string | null>(null);

  // Geographical & Organizational selection
  const [selectedZone, setSelectedZone] = useState('');
  const [selectedDivision, setSelectedDivision] = useState('');
  const [selectedDepartment, setSelectedDepartment] = useState<'Operations' | 'Engineering' | ''>('');
  const [selectedDesignation, setSelectedDesignation] = useState('');
  const [selectedStationKey, setSelectedStationKey] = useState('');
  const [selectedGateIds, setSelectedGateIds] = useState<number[]>([]);

  // Additional dynamic builder values
  const [customData, setCustomData] = useState<Record<string, any>>({});

  // Security declaration
  const [declarationConfirmed, setDeclarationConfirmed] = useState(false);

  // Submission state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // 1. Fetch installed hierarchy & registration form schema
  useEffect(() => {
    const fetchData = async () => {
      setLoadingHierarchy(true);
      try {
        const [hierRes, formRes] = await Promise.all([
          fetch(`${API_URL}/api/v1/auth/installed-hierarchy`),
          fetch(`${API_URL}/api/v1/auth/registration-form`),
        ]);

        if (hierRes.ok) {
          const hierData = await hierRes.json();
          setZones(hierData.zones || []);
          setDepartments(hierData.departments || []);
          if (hierData.zones?.length > 0) {
            setSelectedZone(hierData.zones[0].name);
            if (hierData.zones[0].divisions?.length > 0) {
              setSelectedDivision(hierData.zones[0].divisions[0].name);
            }
          }
          if (hierData.departments?.length > 0) {
            setSelectedDepartment(hierData.departments[0].name as any);
            if (hierData.departments[0].designations?.length > 0) {
              setSelectedDesignation(hierData.departments[0].designations[0].name);
            }
          }
        }

        if (formRes.ok) {
          const formData = await formRes.json();
          if (formData.form) {
            setFormId(formData.form.id);
            try {
              const parsed = JSON.parse(formData.form.schema);
              const fields = Array.isArray(parsed) ? parsed : (parsed.fields || []);
              // Filter out core standard fields that are rendered first-class
              const coreStandardNames = new Set([
                'fullname', 'mobile', 'email', 'employeeid', 'password',
                'department', 'designation', 'zone', 'division', 'station', 'stationid',
                'gate', 'gates', 'gateids', 'idcard', 'declaration', 'roleid'
              ]);
              const extras = fields.filter((f: any) => !coreStandardNames.has((f.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')));
              setCustomFields(extras);
            } catch (_) {}
          }
        }
      } catch (err) {
        console.warn('Failed to load dynamic hierarchy:', err);
      } finally {
        setLoadingHierarchy(false);
      }
    };
    fetchData();
  }, []);

  // Cascading computations
  const currentZone = zones.find(z => z.name === selectedZone);
  const availableDivisions = currentZone?.divisions || [];
  const currentDivision = availableDivisions.find(d => d.name === selectedDivision);
  const availableStations = currentDivision?.stations || [];

  const currentStation = availableStations.find(s => {
    const key = s.id ? `id-${s.id}` : `code-${s.code}`;
    return key === selectedStationKey;
  });
  const availableGates = currentStation?.gates || [];

  const currentDeptInfo = departments.find(d => d.name === selectedDepartment);
  const availableDesignations = currentDeptInfo?.designations || [];
  const currentDesigInfo = availableDesignations.find(d => d.name === selectedDesignation);

  const isStationLevel = currentDesigInfo?.level === 'STATION' || currentDesigInfo?.level === 'GATE';
  const isGateman = currentDesigInfo?.name === 'Gateman';

  // Handle Zone change: automatically invalidate dependent division, station, gates
  const handleZoneChange = (zoneName: string) => {
    setSelectedZone(zoneName);
    const z = zones.find(item => item.name === zoneName);
    const firstDiv = z?.divisions[0]?.name || '';
    setSelectedDivision(firstDiv);
    setSelectedStationKey('');
    setSelectedGateIds([]);
  };

  // Handle Division change: invalidate dependent station, gates
  const handleDivisionChange = (divName: string) => {
    setSelectedDivision(divName);
    setSelectedStationKey('');
    setSelectedGateIds([]);
  };

  // Handle Department change: invalidate designation
  const handleDepartmentChange = (dept: 'Operations' | 'Engineering') => {
    setSelectedDepartment(dept);
    const dInfo = departments.find(d => d.name === dept);
    setSelectedDesignation(dInfo?.designations[0]?.name || '');
    setSelectedStationKey('');
    setSelectedGateIds([]);
  };

  // Handle Designation change: reset gates
  const handleDesignationChange = (desig: string) => {
    setSelectedDesignation(desig);
    setSelectedGateIds([]);
  };

  // File pick
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setIdCardFile(file);
      const reader = new FileReader();
      reader.onload = () => {
        setIdCardPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Mobile number change listener to invalidate verification if altered
  const handleMobileChange = (val: string) => {
    setMobile(val);
    const clean = val.replace(/\D/g, '');
    if (isMobileVerified && clean !== verifiedMobile) {
      setIsMobileVerified(false);
      setVerifiedMobile('');
      setOtpSent(false);
      setOtp('');
    }
  };

  // OTP resend timer countdown
  useEffect(() => {
    if (otpResendCountdown <= 0) return;
    const timer = setInterval(() => {
      setOtpResendCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpResendCountdown]);

  // Send Registration OTP
  const handleSendOtp = async () => {
    const clean = mobile.replace(/\D/g, '');
    if (clean.length !== 10 || !/^[6-9]\d{9}$/.test(clean)) {
      setError('Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.');
      return;
    }
    setError('');
    setIsSendingOtp(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/register/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: clean }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to dispatch verification OTP.');
      } else {
        setOtpSent(true);
        setOtpResendCountdown(60);
      }
    } catch (err: any) {
      setError(err.message || 'Network error sending verification OTP.');
    } finally {
      setIsSendingOtp(false);
    }
  };

  // Verify Registration OTP
  const handleVerifyOtp = async () => {
    const clean = mobile.replace(/\D/g, '');
    if (otp.trim().length !== 6) {
      setError('Please enter the 6-digit OTP code received via SMS.');
      return;
    }
    setError('');
    setIsVerifyingOtp(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/register/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: clean, otp: otp.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.verified) {
        setError(data.error || 'Invalid or expired OTP code.');
      } else {
        setIsMobileVerified(true);
        setVerifiedMobile(clean);
        setOtpSent(false);
      }
    } catch (err: any) {
      setError(err.message || 'Network error verifying OTP.');
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  // Form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validations
    if (!fullName.trim()) {
      setError('Full Name is required.');
      return;
    }
    const cleanMobile = mobile.replace(/\D/g, '');
    if (cleanMobile.length !== 10) {
      setError('Mobile Number must be a 10-digit Indian mobile number.');
      return;
    }
    if (!isMobileVerified || cleanMobile !== verifiedMobile) {
      setError('Please verify your mobile number with OTP before submitting registration.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('A valid official Email Address is required.');
      return;
    }
    if (!employeeId.trim()) {
      setError('Indian Railways Employee ID is required.');
      return;
    }
    if (!password) {
      setError('Password is required.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match. Please re-enter.');
      return;
    }

    if (!selectedZone || !selectedDivision) {
      setError('Please select Railway Zone and Division with active installations.');
      return;
    }

    if (!selectedDepartment || !selectedDesignation) {
      setError('Please select your official Department and Designation.');
      return;
    }

    if (isStationLevel) {
      if (!currentStation || !currentStation.id) {
        setError(`Station selection is mandatory for ${selectedDesignation}.`);
        return;
      }
      if (isGateman) {
        if (selectedGateIds.length !== 1) {
          setError('A Gateman must be assigned to exactly ONE Level Crossing Gate.');
          return;
        }
      } else {
        if (selectedGateIds.length === 0) {
          setError(`Please select at least one Level Crossing Gate under ${currentStation.name}.`);
          return;
        }
      }
    }

    // Official Identity Document upload is optional

    if (!declarationConfirmed) {
      setError('You must accept the official security declaration confirming the accuracy of your details.');
      return;
    }

    setIsLoading(true);

    try {
      const payload = new FormData();

      const registrationData: Record<string, any> = {
        fullName: fullName.trim(),
        mobile: cleanMobile,
        email: email.trim(),
        employeeId: employeeId.trim(),
        password,
        department: selectedDepartment,
        designation: selectedDesignation,
        zone: selectedZone,
        division: selectedDivision,
        stationId: currentStation?.id || null,
        gateIds: selectedGateIds,
        declarationConfirmed: true,
        ...customData
      };

      if (idCardFile) {
        payload.append('idCard', idCardFile);
      }

      payload.append('data', JSON.stringify(registrationData));
      payload.append('department', selectedDepartment);
      payload.append('designation', selectedDesignation);
      payload.append('zone', selectedZone);
      payload.append('division', selectedDivision);
      if (currentStation?.id) {
        payload.append('stationId', currentStation.id.toString());
      }
      payload.append('declarationConfirmed', 'true');
      if (formId) {
        payload.append('formId', formId.toString());
      } else {
        payload.append('formId', '1');
      }

      selectedGateIds.forEach(gid => {
        payload.append('gateIds', gid.toString());
      });

      const res = await fetch(`${API_URL}/api/v1/auth/register`, {
        method: 'POST',
        body: payload
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
        toastSuccess('Registration submitted! Your request will be reviewed by your immediate railway superior.', 'Submitted');
      } else {
        const errMsg = data.error || 'Registration failed. Please verify your details.';
        setError(errMsg);
        toastError(errMsg, 'Submission Failed');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err: any) {
      const msg = err.message || 'Network error submitting registration. Please check connection.';
      setError(msg);
      toastError(msg, 'Network Error');
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div style={{ minHeight: '100vh', background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 16px' }}>
        <div style={{ maxWidth: 480, width: '100%', background: '#ffffff', borderRadius: 16, padding: '36px 28px', textAlign: 'center', boxShadow: '0 10px 25px rgba(0,0,0,0.06)' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ecfdf5', color: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 32 }}>
            <FaCheckCircle />
          </div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
            Registration Submitted Successfully!
          </h2>
          <p style={{ color: '#475569', fontSize: '0.9rem', lineHeight: 1.55, marginBottom: 20 }}>
            Your registration request for <strong>"{selectedDesignation}"</strong> ({selectedDepartment} Department) in <strong>{selectedDivision} Division</strong> has been submitted.
          </p>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, textAlign: 'left', marginBottom: 24, fontSize: '0.82rem', color: '#334155', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700, color: '#0284c7', marginBottom: 4 }}>
              Next Step: Hierarchical Railway Verification
            </div>
            Your application will be verified and approved by your designated immediate superior ({currentDesigInfo?.immediateSuperior || 'Railway Governance Authority'}). Once approved, you will be able to log in and monitor your authorized level crossings.
          </div>
          <button
            type="button"
            onClick={onGoToLogin}
            style={{ width: '100%', padding: '12px 20px', background: 'var(--primary, #0B3C7A)', color: '#ffffff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}
          >
            Return to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 16px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 640, width: '100%', background: '#ffffff', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 8px 30px rgba(0,0,0,0.04)', padding: '32px 28px' }}>
        
        {/* Header Branding */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img
            src="/app_icon.png"
            alt="Indian Railways LC Platform"
            style={{ maxHeight: 68, maxWidth: 120, objectFit: 'contain', marginBottom: 12 }}
          />
          <h2 style={{ fontSize: '1.45rem', fontWeight: 800, color: '#0f172a', margin: '0 0 4px' }}>
            Indian Railways Employee Registration
          </h2>
          <p style={{ fontSize: '0.86rem', color: '#64748b', margin: 0 }}>
            Official Level Crossing Monitoring & Safety Portal
          </p>
        </div>

        {error && (
          <div style={{ padding: '12px 16px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.85rem' }}>
            <FaExclamationTriangle style={{ color: '#dc2626', marginTop: 2, flexShrink: 0 }} />
            <div>
              <strong style={{ display: 'block', color: '#7f1d1d', marginBottom: 2 }}>Registration Issue</strong>
              {error}
            </div>
          </div>
        )}

        {loadingHierarchy ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
            <FaSpinner className="spin" size={24} style={{ marginBottom: 10 }} />
            <div>Loading verified railway installations & designations...</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            
            {/* Section 1: Employee Identity */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: '#0B3C7A', fontWeight: 700, fontSize: '0.95rem' }}>
                <FaIdBadge />
                <span>1. Employee Identification</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Full Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ramesh Kumar Sharma"
                    value={fullName}
                    onChange={e => setFullName(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Employee ID / PF Number *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. EMP-10492"
                    value={employeeId}
                    onChange={e => setEmployeeId(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#334155' }}>Mobile Number (10 Digits) *</label>
                    {isMobileVerified && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#059669', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FaCheckCircle /> Verified
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="tel"
                      required
                      maxLength={10}
                      disabled={isMobileVerified}
                      placeholder="e.g. 9876543210"
                      value={mobile}
                      onChange={e => handleMobileChange(e.target.value)}
                      style={{ flex: 1, padding: '9px 12px', borderRadius: 6, border: isMobileVerified ? '1px solid #10b981' : '1px solid #cbd5e1', background: isMobileVerified ? '#f0fdf4' : '#fff', fontSize: '0.875rem' }}
                    />
                    {!isMobileVerified ? (
                      <button
                        type="button"
                        onClick={handleSendOtp}
                        disabled={isSendingOtp || otpResendCountdown > 0}
                        style={{ padding: '0 14px', background: '#0B3C7A', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600, cursor: isSendingOtp || otpResendCountdown > 0 ? 'not-allowed' : 'pointer', opacity: isSendingOtp || otpResendCountdown > 0 ? 0.7 : 1, whiteSpace: 'nowrap' }}
                      >
                        {isSendingOtp ? 'Sending...' : otpSent ? (otpResendCountdown > 0 ? `Resend (${otpResendCountdown}s)` : 'Resend OTP') : 'Get OTP'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setIsMobileVerified(false);
                          setVerifiedMobile('');
                          setOtpSent(false);
                          setOtp('');
                        }}
                        style={{ padding: '0 12px', background: '#f1f5f9', color: '#0B3C7A', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >
                        Change
                      </button>
                    )}
                  </div>

                  {!isMobileVerified && otpSent && (
                    <div style={{ marginTop: 8, padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6 }}>
                      <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#166534', marginBottom: 4 }}>
                        Enter 6-digit OTP sent to +91 {mobile} via SMS
                      </label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="text"
                          maxLength={6}
                          placeholder="6-digit OTP"
                          value={otp}
                          onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                          style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #86efac', background: '#fff', fontSize: '0.85rem' }}
                        />
                        <button
                          type="button"
                          onClick={handleVerifyOtp}
                          disabled={isVerifyingOtp}
                          style={{ padding: '0 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}
                        >
                          {isVerifyingOtp ? 'Verifying...' : 'Verify OTP'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Official Email Address *</label>
                  <input
                    type="email"
                    required
                    placeholder="e.g. ramesh.sharma@railnet.gov.in"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Create Password *</label>
                  <input
                    type="password"
                    required
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Confirm Password *</label>
                  <input
                    type="password"
                    required
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  />
                </div>
              </div>

              {/* Identity Document Upload (Optional) */}
              <div style={{ marginTop: 14 }}>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                  Official Railway Identity Document (Photo / Scan) (Optional)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem', fontWeight: 600, color: '#0B3C7A', cursor: 'pointer' }}>
                    <FaUpload />
                    <span>Choose ID Card Photo</span>
                    <input type="file" accept="image/*,.pdf" onChange={handleFileChange} style={{ display: 'none' }} />
                  </label>
                  <span style={{ fontSize: '0.8rem', color: idCardFile ? '#059669' : '#64748b' }}>
                    {idCardFile ? idCardFile.name : 'No file chosen (Optional)'}
                  </span>
                  {idCardFile && (
                    <button
                      type="button"
                      onClick={() => { setIdCardFile(null); setIdCardPreview(null); }}
                      style={{ border: 'none', background: 'transparent', color: '#ef4444', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 }}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {idCardPreview && (
                  <div style={{ marginTop: 8 }}>
                    <img src={idCardPreview} alt="ID Preview" style={{ maxHeight: 80, borderRadius: 6, border: '1px solid #cbd5e1' }} />
                  </div>
                )}
              </div>
            </div>

            {/* Section 2: Railway Geographical Installation Mapping */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: '#0B3C7A', fontWeight: 700, fontSize: '0.95rem' }}>
                <FaTrain />
                <span>2. Railway Geographical Jurisdiction (Active Installations Only)</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Railway Zone *</label>
                  <select
                    value={selectedZone}
                    onChange={e => handleZoneChange(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  >
                    {zones.map(z => (
                      <option key={z.name} value={z.name}>{z.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Railway Division *</label>
                  <select
                    value={selectedDivision}
                    onChange={e => handleDivisionChange(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  >
                    {availableDivisions.map(d => (
                      <option key={d.name} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Section 3: Department & Official Designation */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: '#0B3C7A', fontWeight: 700, fontSize: '0.95rem' }}>
                <FaUserTie />
                <span>3. Department & Official Railway Designation</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Department *</label>
                  <select
                    value={selectedDepartment}
                    onChange={e => handleDepartmentChange(e.target.value as any)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  >
                    <option value="Operations">Operations Department</option>
                    <option value="Engineering">Engineering Department</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>Official Designation *</label>
                  <select
                    value={selectedDesignation}
                    onChange={e => handleDesignationChange(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  >
                    {availableDesignations.map(d => (
                      <option key={d.name} value={d.name}>
                        {d.name} {d.immediateSuperior ? `(Reports to ${d.immediateSuperior})` : '(Divisional Head)'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {currentDesigInfo && (
                <div style={{ marginTop: 10, padding: 10, background: '#e0f2fe', borderRadius: 8, fontSize: '0.8rem', color: '#0369a1', lineHeight: 1.45 }}>
                  <strong>Scope & Responsibility: </strong>{currentDesigInfo.description}.
                  {currentDesigInfo.level === 'DIVISIONAL' && ' Division-level jurisdiction (covers all level crossings in the assigned division).'}
                </div>
              )}
            </div>

            {/* Section 4: Conditional Station & Level Crossing Gate Selection */}
            {isStationLevel && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: '#0B3C7A', fontWeight: 700, fontSize: '0.95rem' }}>
                  <FaBuilding />
                  <span>4. Station & Assigned Level Crossing(s)</span>
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                    Railway Station (with configured LC Gates) *
                  </label>
                  <select
                    value={selectedStationKey}
                    onChange={e => {
                      setSelectedStationKey(e.target.value);
                      setSelectedGateIds([]);
                    }}
                    style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                  >
                    <option value="">-- Select Installed Station --</option>
                    {availableStations.map(st => {
                      const key = st.id ? `id-${st.id}` : `code-${st.code}`;
                      return (
                        <option key={key} value={key}>
                          {st.name} ({st.code}) - {st.gates.length} LC Gate{st.gates.length === 1 ? '' : 's'}
                        </option>
                      );
                    })}
                  </select>
                </div>

                {/* LC Gate Selection */}
                {selectedStationKey && (
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                      {isGateman ? 'Assigned Level Crossing Gate (Select Exactly ONE Gate) *' : 'Assigned Level Crossing Gate(s) under this Station *'}
                    </label>

                    {availableGates.length === 0 ? (
                      <div style={{ fontSize: '0.82rem', color: '#64748b', fontStyle: 'italic' }}>
                        No configured LC Gates under this station yet.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {availableGates.map(gate => {
                          const isChecked = selectedGateIds.includes(gate.id);
                          return (
                            <label
                              key={gate.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '10px 14px',
                                background: isChecked ? '#eff6ff' : '#ffffff',
                                border: `1px solid ${isChecked ? '#3b82f6' : '#cbd5e1'}`,
                                borderRadius: 8,
                                cursor: 'pointer',
                                fontSize: '0.85rem'
                              }}
                            >
                              <input
                                type={isGateman ? 'radio' : 'checkbox'}
                                name="selectedGate"
                                checked={isChecked}
                                onChange={() => {
                                  if (isGateman) {
                                    setSelectedGateIds([gate.id]);
                                  } else {
                                    if (isChecked) {
                                      setSelectedGateIds(selectedGateIds.filter(id => id !== gate.id));
                                    } else {
                                      setSelectedGateIds([...selectedGateIds, gate.id]);
                                    }
                                  }
                                }}
                              />
                              <div style={{ flex: 1 }}>
                                <strong style={{ color: '#0f172a' }}>{gate.lcNumber}</strong>
                                {gate.name && gate.name !== gate.lcNumber && <span style={{ color: '#475569', marginLeft: 8 }}>({gate.name})</span>}
                                <span style={{ color: '#64748b', marginLeft: 8 }}>• {gate.locationName}</span>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Custom Builder Fields (Compatibility with Registration Builder) */}
            {customFields.length > 0 && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }}>
                <div style={{ fontWeight: 700, color: '#0B3C7A', fontSize: '0.95rem', marginBottom: 12 }}>
                  Additional Information
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                  {customFields.map((field: any) => (
                    <div key={field.id || field.name}>
                      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                        {field.label} {field.required ? '*' : ''}
                      </label>
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        required={field.required}
                        placeholder={field.placeholder || ''}
                        value={customData[field.name] || ''}
                        onChange={e => setCustomData({ ...customData, [field.name]: e.target.value })}
                        style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: '0.875rem' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Section 5: Official Verification Warning & Declaration (Section 6) */}
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: '#b45309', marginBottom: 12 }}>
                <FaShieldAlt size={20} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.8rem', lineHeight: 1.5, color: '#92400e' }}>
                  <strong>IMPORTANT SECURITY NOTICE: </strong>
                  This application is intended exclusively for authorized Indian Railways personnel associated with the listed level crossings. All submitted employee information, official designations, identity documents and geographical assignments are subject to verification by the designated railway authority.
                  <br /><br />
                  Please ensure that you select your actual department, official designation, division, station and assigned level crossing(s). Submission of incorrect information, misrepresentation of official designation or unauthorized registration attempts may result in rejection of your application and further action as per applicable organizational policies.
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: '0.82rem', color: '#1e293b', fontWeight: 600, lineHeight: 1.45 }}>
                <input
                  type="checkbox"
                  required
                  checked={declarationConfirmed}
                  onChange={e => setDeclarationConfirmed(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  I hereby declare that all the information, designation, and geographical assignments provided above are accurate and strictly pertain to my official posting in Indian Railways.
                </span>
              </label>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              style={{
                padding: '13px 24px',
                background: 'var(--primary, #0B3C7A)',
                color: '#ffffff',
                border: 'none',
                borderRadius: 8,
                fontSize: '0.95rem',
                fontWeight: 700,
                cursor: isLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                boxShadow: '0 4px 12px rgba(11, 60, 122, 0.2)'
              }}
            >
              {isLoading ? (
                <>
                  <FaSpinner className="spin" />
                  <span>Submitting Application...</span>
                </>
              ) : (
                <span>Submit Official Registration Request</span>
              )}
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: 24, fontSize: '0.85rem' }}>
          <span style={{ color: '#64748b' }}>Already have an approved account? </span>
          <button
            type="button"
            onClick={onGoToLogin}
            style={{ background: 'none', border: 'none', color: '#0B3C7A', fontWeight: 700, cursor: 'pointer', padding: 0 }}
          >
            Sign In Here
          </button>
        </div>
      </div>
    </div>
  );
}
