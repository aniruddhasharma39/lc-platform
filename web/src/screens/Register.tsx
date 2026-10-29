import { useState, useEffect } from 'react';
import FormRenderer from '../components/FormBuilder/FormRenderer';
import { API_URL } from '../config';
import { FaExclamationTriangle } from 'react-icons/fa';
import { useToast } from '../context/ToastContext';

type Props = {
  onGoToLogin: () => void;
};

const DEFAULT_FALLBACK_SCHEMA = {
  fields: [
    { id: '1', type: 'text', name: 'fullName', label: 'Full Name', required: true, placeholder: 'Enter your full name' },
    { id: '2', type: 'phone', name: 'mobile', label: 'Mobile Number', required: true, unique: true, placeholder: '10-digit mobile number' },
    { id: '3', type: 'email', name: 'email', label: 'Email Address', required: true, unique: true, placeholder: 'name@example.com' },
    { id: '4', type: 'text', name: 'employeeId', label: 'Employee ID', required: true, unique: true, placeholder: 'e.g. EMP-101' },
    { id: '5', type: 'text', name: 'department', label: 'Department', required: true, placeholder: 'e.g. Engineering' }
  ],
  allowRoles: true
};

export default function Register({ onGoToLogin }: Props) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [schema, setSchema] = useState<any>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [formId, setFormId] = useState<number | null>(null);

  useEffect(() => {
    const fetchForm = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/registration-form`);
        if (!res.ok) {
          throw new Error('Registration form not available');
        }
        const data = await res.json();
        
        if (data.form) {
          setFormId(data.form.id);
          const parsed = JSON.parse(data.form.schema);
          if (Array.isArray(parsed)) {
            // Backward compatibility for old array schema
            setSchema({ fields: parsed, allowRoles: true });
          } else {
            setSchema(parsed);
          }
        } else {
          setSchema(DEFAULT_FALLBACK_SCHEMA);
        }
        if (data.roles) {
          setRoles(data.roles);
        }
      } catch (err) {
        console.warn('Using default registration schema:', err);
        setSchema(DEFAULT_FALLBACK_SCHEMA);
        // Also fetch roles independently if possible
        fetch(`${API_URL}/api/v1/roles`)
          .then(r => r.json())
          .then(data => {
            if (Array.isArray(data)) setRoles(data.filter((r: any) => r.name !== 'Developer'));
          })
          .catch(() => {});
      }
    };
    fetchForm();
  }, []);

  const handleSubmit = async (formData: any) => {
    setIsLoading(true);
    setError('');

    // If schema has image files, we'd need FormData. 
    // For simplicity, we assume we send JSON if no files, or FormData if files exist.
    // Let's check if there are any File objects.
    const hasFiles = Object.values(formData).some(v => v instanceof File);

    try {
      let fetchOptions: RequestInit = {};

      if (hasFiles) {
        const payload = new FormData();
        const plainData = { ...formData };
        
        Object.entries(formData).forEach(([key, val]) => {
          if (val instanceof File) {
            payload.append(key, val);
            delete plainData[key];
          }
        });
        
        payload.append('data', JSON.stringify(plainData));
        if (formData.roleId) payload.append('roleId', formData.roleId);
        if (formId) payload.append('formId', formId.toString());

        fetchOptions = {
          method: 'POST',
          body: payload, // no content type, browser sets it to multipart/form-data with boundary
        };
      } else {
        fetchOptions = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            data: formData, 
            roleId: formData.roleId ? parseInt(formData.roleId) : undefined,
            formId: formId
          })
        };
      }

      const res = await fetch(`${API_URL}/api/v1/auth/register`, fetchOptions);
      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
        toastSuccess('Registration submitted successfully! Your account request is pending administrator verification.', 'Request Submitted');
      } else {
        const errMsg = data.error || 'Registration failed. Please check your submission.';
        setError(errMsg);
        toastError(errMsg, 'Registration Rejected');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      const netMsg = 'Network error submitting registration. Please check connection and retry.';
      setError(netMsg);
      toastError(netMsg, 'Network Error');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="bg-light" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', width: '100%', padding: '40px 24px', overflowY: 'auto' }}>
        <div className="card text-center" style={{ width: 400 }}>
          <h2 className="text-primary mb-4">Registration Submitted!</h2>
          <p className="text-muted mb-6">Your registration request has been submitted and is pending administrator approval. You will be notified once your account is activated.</p>
          <button className="primary outline" onClick={onGoToLogin} style={{ width: '100%' }}>Return to Login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-light" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', width: '100%', padding: '40px 24px', overflowY: 'auto' }}>
      <div className="card" style={{ width: 500, maxWidth: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
          <img
            src="/app_icon.png"
            alt="LC Platform"
            style={{
              maxHeight: '75px',
              maxWidth: '120px',
              width: 'auto',
              height: 'auto',
              borderRadius: '12px',
              objectFit: 'contain',
              filter: 'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.12))',
            }}
          />
        </div>
        <h2 className="text-center text-primary mb-6">Create an Account</h2>
        
        {error && (
          <div 
            className="registration-error-alert mb-5" 
            style={{ 
              padding: '14px 16px', 
              borderRadius: '8px', 
              background: '#fef2f2', 
              border: '1px solid #fecaca',
              color: '#991b1b',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '12px',
              fontSize: '0.88rem',
              lineHeight: 1.45,
              boxShadow: '0 2px 8px rgba(220, 38, 38, 0.08)'
            }}
          >
            <FaExclamationTriangle style={{ color: '#dc2626', fontSize: '1.25rem', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', marginBottom: '3px', color: '#7f1d1d', fontSize: '0.92rem' }}>
                {error.toLowerCase().includes('already exists') || error.toLowerCase().includes('pending')
                  ? 'User Already Exists / Account Collision'
                  : 'Registration Issue'}
              </strong>
              <span>{error}</span>
              {(error.toLowerCase().includes('already exists') || error.toLowerCase().includes('log in') || error.toLowerCase().includes('already registered')) && (
                <div style={{ marginTop: '10px' }}>
                  <button 
                    type="button" 
                    onClick={onGoToLogin} 
                    style={{ 
                      padding: '6px 14px', 
                      fontSize: '0.82rem', 
                      background: '#dc2626', 
                      color: '#ffffff', 
                      border: 'none', 
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    Go to Login
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {!schema ? (
          <div className="text-center text-muted">Loading registration form...</div>
        ) : (
          <FormRenderer 
            schema={schema} 
            roles={roles} 
            onSubmit={handleSubmit} 
            isSubmitting={isLoading} 
            requirePassword={true}
          />
        )}

        <div className="text-center mt-6">
          <span className="text-muted">Already have an account? </span>
          <button className="icon-btn text-primary fw-bold" onClick={onGoToLogin}>Login</button>
        </div>
      </div>
    </div>
  );
}
