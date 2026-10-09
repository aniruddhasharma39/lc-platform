import React, { useState, useEffect } from 'react';

type Props = {
  onGoToLogin: () => void;
};

export default function Register({ onGoToLogin }: Props) {
  const [formData, setFormData] = useState({
    fullName: '',
    mobile: '',
    email: '',
    employeeId: '',
    department: 'IT',
    requestedRoleId: 0,
    password: '',
    confirmPassword: '',
  });
  
  const [roles, setRoles] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('http://localhost:5001/api/v1/users/roles', {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}` // Although not strictly needed for this open endpoint if we changed it, but let's just fetch open roles
      }
    })
      .then(res => res.json())
      .then(data => {
        // Exclude Developer
        const filteredRoles = data.filter((r: any) => r.name !== 'Developer');
        setRoles(filteredRoles);
        if (filteredRoles.length > 0) {
          setFormData(f => ({ ...f, requestedRoleId: filteredRoles[0].id }));
        }
      })
      .catch(err => console.error(err));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (formData.password !== formData.confirmPassword) {
      return setError('Passwords do not match');
    }

    setLoading(true);

    try {
      const res = await fetch('http://localhost:5001/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          requestedRoleId: Number(formData.requestedRoleId)
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex items-center justify-center w-full" style={{ minHeight: '100vh' }}>
        <div className="card text-center" style={{ width: '100%', maxWidth: '400px' }}>
          <h2 style={{ color: 'var(--success)' }}>Registration Successful</h2>
          <p className="mt-4 mb-4">Your request has been sent to the admin for approval. You cannot log in until it is approved.</p>
          <button className="primary" onClick={onGoToLogin}>Go to Login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center w-full" style={{ minHeight: '100vh', padding: '2rem 0' }}>
      <div className="card" style={{ width: '100%', maxWidth: '500px' }}>
        <h2 className="text-center" style={{ color: 'var(--primary)', marginBottom: '1.5rem' }}>Register</h2>
        
        {error && (
          <div className="card mb-4" style={{ backgroundColor: 'rgba(214, 69, 69, 0.1)', borderColor: 'var(--danger)', color: 'var(--danger)', padding: '0.75rem' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex-col gap-2">
          <label className="text-sm text-muted">Full Name</label>
          <input name="fullName" value={formData.fullName} onChange={handleChange} required />
          
          <label className="text-sm text-muted">Mobile Number</label>
          <input name="mobile" value={formData.mobile} onChange={handleChange} required />
          
          <label className="text-sm text-muted">Email</label>
          <input type="email" name="email" value={formData.email} onChange={handleChange} required />
          
          <label className="text-sm text-muted">Employee ID</label>
          <input name="employeeId" value={formData.employeeId} onChange={handleChange} required />
          
          <label className="text-sm text-muted">Department</label>
          <select name="department" value={formData.department} onChange={handleChange}>
            <option value="IT">IT</option>
            <option value="Operations">Operations</option>
            <option value="Maintenance">Maintenance</option>
          </select>

          <label className="text-sm text-muted">Role Requested</label>
          <select name="requestedRoleId" value={formData.requestedRoleId} onChange={handleChange}>
            {roles.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          
          <label className="text-sm text-muted">Password</label>
          <input type="password" name="password" value={formData.password} onChange={handleChange} required />
          
          <label className="text-sm text-muted">Confirm Password</label>
          <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} required />

          <button type="submit" className="primary w-full mt-4" disabled={loading}>
            {loading ? 'Registering...' : 'Register'}
          </button>
        </form>

        <div className="text-center mt-4">
          <span className="text-muted text-sm">Already have an account? </span>
          <button className="outline" style={{ border: 'none', color: 'var(--secondary)', padding: 0 }} onClick={onGoToLogin}>
            Login
          </button>
        </div>
      </div>
    </div>
  );
}
