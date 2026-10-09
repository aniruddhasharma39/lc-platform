import { useState, useEffect } from 'react';
import FormRenderer from '../components/FormBuilder/FormRenderer';

type Props = {
  onGoToLogin: () => void;
};

export default function Register({ onGoToLogin }: Props) {
  const [schema, setSchema] = useState<any>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [formId, setFormId] = useState<number | null>(null);

  useEffect(() => {
    const fetchForm = async () => {
      try {
        const res = await fetch('https://lc-platform.onrender.com/api/v1/auth/registration-form');
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
        }
        if (data.roles) {
          setRoles(data.roles);
        }
      } catch (err) {
        console.error(err);
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

      const res = await fetch('https://lc-platform.onrender.com/api/v1/auth/register', fetchOptions);
      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
      } else {
        setError(data.error || 'Registration failed');
      }
    } catch (err) {
      setError('Network error');
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
        <h2 className="text-center text-primary mb-6">Create an Account</h2>
        
        {error && (
          <div className="bg-danger text-white mb-4" style={{ padding: 12, borderRadius: 4 }}>
            {error}
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
