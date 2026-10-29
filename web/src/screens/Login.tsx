import React, { useState, useEffect } from 'react';
import { FaLightbulb, FaMobileAlt, FaEnvelope, FaExclamationTriangle, FaCheckCircle } from 'react-icons/fa';
import type { User } from '../types';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';

type Props = {
  onLogin: (user: User, token: string) => void;
  onGoToRegister: () => void;
  sessionExpiredMsg?: string;
};

export default function Login({ onLogin, onGoToRegister, sessionExpiredMsg }: Props) {
  const { success: toastSuccess, error: toastError, warning: toastWarning, info: toastInfo } = useToast();

  // Mode: standard password login vs OTP login / recovery
  const [mode, setMode] = useState<'password' | 'otp'>('password');

  // Password Login State
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // OTP Login State
  const [otpTab, setOtpTab] = useState<'phone' | 'email'>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // Optional Password Reset on OTP
  const [wantsReset, setWantsReset] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Smart suggestion alert if account registered with alternative method
  const [suggestion, setSuggestion] = useState<{ alternative: 'phone' | 'email'; message: string } | null>(null);

  // General state
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Form capabilities (from active registration form)
  const [hasEmailField, setHasEmailField] = useState(true);
  const [hasPhoneField, setHasPhoneField] = useState(true);

  // Branding
  const [branding, setBranding] = useState<{
    appName: string;
    wallpaperUrl?: string;
    logoUrl?: string;
    loginGradient?: string;
  }>(() => {
    try {
      const cached = localStorage.getItem('cached_branding');
      if (cached) return JSON.parse(cached);
    } catch (_) {}
    return { appName: 'LC Platform', wallpaperUrl: '', logoUrl: '', loginGradient: 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)' };
  });

  useEffect(() => {
    fetch(`${API_URL}/api/v1/settings/branding`)
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          setBranding(data);
          try {
            localStorage.setItem('cached_branding', JSON.stringify(data));
          } catch (_) {}
        }
      })
      .catch(err => console.error(err));

    fetch(`${API_URL}/api/v1/auth/registration-form`)
      .then(res => res.json())
      .then(data => {
        if (data.hasEmailField !== undefined) setHasEmailField(data.hasEmailField);
        if (data.hasPhoneField !== undefined) setHasPhoneField(data.hasPhoneField);

        // Adjust active tab if only one is available in active form
        if (data.hasPhoneField && !data.hasEmailField) {
          setOtpTab('phone');
        } else if (data.hasEmailField && !data.hasPhoneField) {
          setOtpTab('email');
        }
      })
      .catch(err => console.error(err));
  }, []);

  // Countdown timer for OTP resend
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown(prev => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // Standard Password Login
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!identifier.trim() || !password.trim()) {
      const msg = 'Please enter your login identifier and password.';
      setError(msg);
      toastWarning(msg, 'Validation Required');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }

      onLogin(data.user, data.token);
    } catch (err: any) {
      setError(err.message);
      toastError(err.message || 'Login failed. Please verify your credentials.', 'Authentication Failed');
    } finally {
      setLoading(false);
    }
  };

  // Send OTP
  const handleSendOtp = async () => {
    setError('');
    setSuccessMsg('');
    setSuggestion(null);

    const target = otpTab === 'phone' ? phoneInput.trim() : emailInput.trim();

    // Client-side validations
    if (otpTab === 'phone') {
      const digits = target.replace(/\D/g, '');
      if (!/^[6-9]\d{9}$/.test(digits)) {
        const msg = 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.';
        setError(msg);
        toastWarning(msg, 'Invalid Mobile Number');
        return;
      }
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
        const msg = 'Please enter a valid email address containing @ and domain.';
        setError(msg);
        toastWarning(msg, 'Invalid Email Format');
        return;
      }
    }

    setSendingOtp(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: otpTab, identifier: target }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.suggestAlternative && data.suggestionMessage) {
          setSuggestion({
            alternative: data.suggestAlternative,
            message: data.suggestionMessage,
          });
        }
        throw new Error(data.error || 'Failed to send OTP');
      }

      setOtpSent(true);
      setCountdown(60);
      const msg = data.message || `OTP dispatched successfully to ${target}!`;
      setSuccessMsg(msg);
      toastSuccess(msg, 'OTP Dispatched');
    } catch (err: any) {
      setError(err.message);
      toastError(err.message || 'Failed to send OTP.', 'OTP Request Failed');
    } finally {
      setSendingOtp(false);
    }
  };

  // Verify OTP & Login
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!otpCode || otpCode.trim().length !== 6) {
      const msg = 'Please enter the complete 6-digit OTP code.';
      setError(msg);
      toastWarning(msg, 'Incomplete Code');
      return;
    }

    if (wantsReset) {
      if (!newPassword || newPassword.length < 6) {
        const msg = 'New password must be at least 6 characters long.';
        setError(msg);
        toastWarning(msg, 'Password Too Short');
        return;
      }
      if (newPassword !== confirmPassword) {
        const msg = 'New password and confirm password do not match.';
        setError(msg);
        toastWarning(msg, 'Password Mismatch');
        return;
      }
    }

    setLoading(true);
    try {
      const target = otpTab === 'phone' ? phoneInput.trim() : emailInput.trim();
      const res = await fetch(`${API_URL}/api/v1/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: otpTab,
          identifier: target,
          otp: otpCode.trim(),
          ...(wantsReset ? { newPassword: newPassword.trim() } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to verify OTP');
      }

      onLogin(data.user, data.token);
    } catch (err: any) {
      setError(err.message);
      toastError(err.message || 'Failed to verify OTP. Please try again.', 'Verification Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="flex items-center justify-center w-full"
      style={{
        minHeight: '100vh',
        background: branding.loginGradient || 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)',
        padding: '1.5rem',
      }}
    >
      <div
        className="card slide-up"
        style={{
          width: '100%',
          maxWidth: '440px',
          backgroundColor: 'rgba(255,255,255,0.98)',
          backdropFilter: 'blur(20px)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          borderRadius: '20px',
          padding: '2.5rem 2rem 2rem 2rem',
          border: '1px solid rgba(255,255,255,0.8)',
        }}
      >
        <div className="text-center mb-6">
          {(branding.logoUrl || branding.wallpaperUrl) && (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
              <img
                src={branding.logoUrl || branding.wallpaperUrl}
                alt={branding.appName}
                style={{
                  maxHeight: '90px',
                  maxWidth: '160px',
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  filter: 'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.12))',
                }}
              />
            </div>
          )}
          <h2 style={{ color: 'var(--primary)', margin: '0 0 0.5rem 0', fontWeight: 800, fontSize: '1.65rem' }}>
            {branding.appName}
          </h2>
          <p className="text-sm text-muted m-0">
            {mode === 'password'
              ? 'Sign in to access your dashboard'
              : 'Password Recovery & OTP Authentication'}
          </p>
        </div>

        {sessionExpiredMsg && (
          <div
            className="mb-4 fade-in"
            style={{
              backgroundColor: 'rgba(245, 166, 35, 0.15)',
              border: '1px solid var(--accent)',
              color: '#92400e',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontSize: '0.9rem',
              fontWeight: 600,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FaExclamationTriangle style={{ flexShrink: 0, color: '#d97706' }} />
              <span>{sessionExpiredMsg}</span>
            </div>
          </div>
        )}

        {error && (
          <div
            className="mb-4 fade-in"
            style={{
              backgroundColor: 'rgba(214, 69, 69, 0.1)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontSize: '0.9rem',
              fontWeight: 500,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FaExclamationTriangle style={{ flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          </div>
        )}

        {successMsg && (
          <div
            className="mb-4 fade-in"
            style={{
              backgroundColor: 'rgba(46, 158, 91, 0.12)',
              border: '1px solid var(--success)',
              color: 'var(--success)',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              fontSize: '0.9rem',
              fontWeight: 600,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <FaCheckCircle style={{ flexShrink: 0 }} />
              <span>{successMsg}</span>
            </div>
          </div>
        )}

        {/* Suggestion alert when identifier belongs to alternative tab */}
        {suggestion && (
          <div
            className="mb-4 fade-in"
            style={{
              backgroundColor: 'rgba(245, 166, 35, 0.15)',
              border: '1px solid var(--accent)',
              borderRadius: '10px',
              padding: '12px 14px',
              color: '#92400e',
              fontSize: '0.88rem',
            }}
          >
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <FaLightbulb color="#d97706" size={14} /> Account Notice
            </div>
            <div>{suggestion.message}</div>
            <button
              type="button"
              className="primary"
              style={{
                marginTop: '10px',
                padding: '6px 14px',
                fontSize: '0.82rem',
                backgroundColor: 'var(--primary)',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
              onClick={() => {
                const targetTab = suggestion.alternative;
                setOtpTab(targetTab);
                setSuggestion(null);
                setError('');
                setOtpSent(false);
              }}
            >
              {suggestion.alternative === 'phone' ? (
                <>Switch to <FaMobileAlt size={13} /> Mobile OTP</>
              ) : (
                <>Switch to <FaEnvelope size={13} /> Email OTP</>
              )}
            </button>
          </div>
        )}

        {/* ================= MODE: PASSWORD LOGIN ================= */}
        {mode === 'password' && (
          <form onSubmit={handlePasswordSubmit} className="flex-col gap-4">
            <div>
              <label className="text-sm font-semibold text-muted block mb-1">
                Mobile Number, Email, or Employee ID
              </label>
              <input
                type="text"
                placeholder="e.g. 9876543210 or user@example.com"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                style={{ width: '100%', padding: '10px 14px' }}
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-sm font-semibold text-muted">Password</label>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontSize: '0.8rem',
                    color: 'var(--secondary)',
                    fontWeight: 600,
                  }}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                style={{ width: '100%', padding: '10px 14px' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '-4px' }}>
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  fontSize: '0.85rem',
                  color: 'var(--primary)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setError('');
                  setSuccessMsg('');
                  setSuggestion(null);
                  setMode('otp');
                  toastInfo('Switched to OTP Verification & Password Recovery mode.', 'Mode Switched');
                }}
              >
                Forgot Password / Login with OTP →
              </button>
            </div>

            <button
              type="submit"
              className="primary w-full mt-2"
              disabled={loading}
              style={{ padding: '12px', fontSize: '1rem' }}
            >
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
        )}

        {/* ================= MODE: OTP LOGIN / FORGOT PASSWORD ================= */}
        {mode === 'otp' && (
          <div className="flex-col gap-4">
            {/* Dynamic Tab Navigation: Mobile OTP vs Email OTP */}
            <div
              style={{
                display: 'flex',
                backgroundColor: 'rgba(0,0,0,0.04)',
                padding: '4px',
                borderRadius: '10px',
                marginBottom: '1rem',
              }}
            >
              {hasPhoneField && (
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: '8px',
                    fontSize: '0.88rem',
                    borderRadius: '8px',
                    backgroundColor: otpTab === 'phone' ? '#fff' : 'transparent',
                    color: otpTab === 'phone' ? 'var(--primary)' : 'var(--text-muted)',
                    boxShadow: otpTab === 'phone' ? '0 2px 6px rgba(0,0,0,0.08)' : 'none',
                    fontWeight: otpTab === 'phone' ? 700 : 500,
                  }}
                  onClick={() => {
                    setOtpTab('phone');
                    setError('');
                    setSuggestion(null);
                    setOtpSent(false);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <FaMobileAlt size={14} /> Mobile OTP
                  </span>
                </button>
              )}

              {hasEmailField && (
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: '8px',
                    fontSize: '0.88rem',
                    borderRadius: '8px',
                    backgroundColor: otpTab === 'email' ? '#fff' : 'transparent',
                    color: otpTab === 'email' ? 'var(--primary)' : 'var(--text-muted)',
                    boxShadow: otpTab === 'email' ? '0 2px 6px rgba(0,0,0,0.08)' : 'none',
                    fontWeight: otpTab === 'email' ? 700 : 500,
                  }}
                  onClick={() => {
                    setOtpTab('email');
                    setError('');
                    setSuggestion(null);
                    setOtpSent(false);
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <FaEnvelope size={14} /> Email OTP
                  </span>
                </button>
              )}
            </div>

            {/* Target Input (Phone or Email) */}
            <div>
              <label className="text-sm font-semibold text-muted block mb-1">
                {otpTab === 'phone' ? 'Registered Mobile Number *' : 'Registered Email Address *'}
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {otpTab === 'phone' ? (
                  <div style={{ position: 'relative', flex: 1 }}>
                    <span
                      style={{
                        position: 'absolute',
                        left: '12px',
                        top: '11px',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        fontSize: '0.9rem',
                      }}
                    >
                      +91
                    </span>
                    <input
                      type="tel"
                      placeholder="9876543210 (10 digits)"
                      value={phoneInput}
                      maxLength={10}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setPhoneInput(val);
                      }}
                      disabled={otpSent}
                      style={{ width: '100%', padding: '10px 14px 10px 50px' }}
                    />
                  </div>
                ) : (
                  <input
                    type="email"
                    placeholder="name@example.com"
                    value={emailInput}
                    onChange={e => setEmailInput(e.target.value)}
                    disabled={otpSent}
                    style={{ flex: 1, padding: '10px 14px' }}
                  />
                )}

                {/* Send / Change Button */}
                {!otpSent ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={handleSendOtp}
                    disabled={sendingOtp}
                    style={{ whiteSpace: 'nowrap', padding: '10px 16px' }}
                  >
                    {sendingOtp ? 'Sending...' : 'Send OTP'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="outline"
                    onClick={() => {
                      setOtpSent(false);
                      setOtpCode('');
                    }}
                    style={{ whiteSpace: 'nowrap', padding: '10px 14px', fontSize: '0.85rem' }}
                  >
                    Change
                  </button>
                )}
              </div>
              <small className="text-muted block mt-1">
                {otpTab === 'phone'
                  ? 'Indian 10-digit number starting with 6, 7, 8, or 9'
                  : 'Email address registered with your account'}
              </small>
            </div>

            {/* OTP Verification Section (Revealed when OTP is sent) */}
            {otpSent && (
              <form onSubmit={handleVerifyOtp} className="flex-col gap-4 mt-2 fade-in">

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-sm font-semibold text-muted">Enter 6-Digit OTP *</label>
                    {countdown > 0 ? (
                      <span className="text-xs text-muted">Resend in {countdown}s</span>
                    ) : (
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          fontSize: '0.8rem',
                          color: 'var(--primary)',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                        onClick={handleSendOtp}
                        disabled={sendingOtp}
                      >
                        Resend OTP
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="Enter 6-digit code"
                    maxLength={6}
                    value={otpCode}
                    onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    style={{
                      width: '100%',
                      padding: '12px',
                      textAlign: 'center',
                      fontSize: '1.25rem',
                      letterSpacing: '8px',
                      fontWeight: 700,
                    }}
                  />
                </div>

                {/* Optional Password Reset Toggle */}
                <div
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.02)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '12px',
                  }}
                >
                  <label className="flex items-center gap-2 cursor-pointer" style={{ margin: 0, fontSize: '0.9rem' }}>
                    <input
                      type="checkbox"
                      checked={wantsReset}
                      onChange={e => setWantsReset(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span className="font-semibold" style={{ color: 'var(--primary)' }}>
                      Set a new password after login
                    </span>
                  </label>

                  {wantsReset && (
                    <div className="flex-col gap-3 mt-3 fade-in">
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label className="text-xs text-muted font-semibold">New Password (min 6 chars)</label>
                          <button
                            type="button"
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              fontSize: '0.75rem',
                              color: 'var(--secondary)',
                            }}
                            onClick={() => setShowNewPassword(!showNewPassword)}
                          >
                            {showNewPassword ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        <input
                          type={showNewPassword ? 'text' : 'password'}
                          placeholder="Create new password"
                          value={newPassword}
                          onChange={e => setNewPassword(e.target.value)}
                          required={wantsReset}
                          style={{ width: '100%', padding: '8px 12px', fontSize: '0.9rem' }}
                        />
                      </div>

                      <div>
                        <label className="text-xs text-muted font-semibold block mb-1">Confirm New Password</label>
                        <input
                          type={showNewPassword ? 'text' : 'password'}
                          placeholder="Confirm new password"
                          value={confirmPassword}
                          onChange={e => setConfirmPassword(e.target.value)}
                          required={wantsReset}
                          style={{ width: '100%', padding: '8px 12px', fontSize: '0.9rem' }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="primary w-full mt-2"
                  disabled={loading}
                  style={{ padding: '12px', fontSize: '1rem' }}
                >
                  {loading ? 'Verifying...' : wantsReset ? 'Verify OTP & Reset Password' : 'Verify & Log In'}
                </button>
              </form>
            )}

            {/* Back to Password Login Link */}
            <div className="text-center mt-3">
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--text-muted)',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setMode('password');
                  setError('');
                  setSuccessMsg('');
                  setSuggestion(null);
                  setOtpSent(false);
                  toastInfo('Returned to standard password login.', 'Mode Switched');
                }}
              >
                ← Back to Password Login
              </button>
            </div>
          </div>
        )}

        <div className="text-center mt-6 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="text-muted text-sm">Don't have an account? </span>
          <button
            className="outline"
            style={{ border: 'none', color: 'var(--secondary)', padding: 0, fontWeight: 700 }}
            onClick={onGoToRegister}
          >
            Register Here
          </button>
        </div>
      </div>
    </div>
  );
}
