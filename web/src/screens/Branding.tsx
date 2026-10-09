import { useEffect, useState } from 'react';
import type { User } from '../types';

type Props = {
  user: User;
};

export default function Branding({}: Props) {
  const [appName, setAppName] = useState('');
  const [wallpaperUrl, setWallpaperUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('https://lc-platform.onrender.com/api/v1/settings/branding')
      .then(res => res.json())
      .then(data => {
        if (data.appName) setAppName(data.appName);
        if (data.wallpaperUrl) setWallpaperUrl(data.wallpaperUrl);
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const formData = new FormData();
    formData.append('appName', appName);
    if (file) {
      formData.append('wallpaper', file);
    }

    try {
      const res = await fetch('https://lc-platform.onrender.com/api/v1/settings/branding', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: formData
      });

      const data = await res.json();
      if (res.ok) {
        setAppName(data.appName);
        if (data.wallpaperUrl) setWallpaperUrl(data.wallpaperUrl);
        setFile(null);
        alert('Branding updated successfully!');
      } else {
        alert(data.error || 'Failed to update branding');
      }
    } catch (err) {
      console.error(err);
      alert('Error updating branding');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: '800px', margin: '0 auto', marginTop: '2rem' }}>
      <h2 style={{ marginBottom: '1.5rem', color: 'var(--primary)', textAlign: 'center' }}>App Branding</h2>
      
      <form onSubmit={handleSubmit} className="flex-col gap-4">
        <div>
          <label>App Name</label>
          <input 
            type="text" 
            value={appName} 
            onChange={e => setAppName(e.target.value)} 
            placeholder="e.g. LC Platform"
          />
        </div>

        <div>
          <label>Wallpaper Image (Login Screen)</label>
          {wallpaperUrl && (
            <div className="mb-2">
              <img src={wallpaperUrl} alt="Current Wallpaper" style={{ maxHeight: '150px', borderRadius: '8px', objectFit: 'cover' }} />
            </div>
          )}
          <input 
            type="file" 
            accept="image/*" 
            onChange={e => setFile(e.target.files ? e.target.files[0] : null)}
          />
        </div>

        <div className="mt-4">
          <button type="submit" className="primary" disabled={loading}>
            {loading ? 'Saving...' : 'Save Branding'}
          </button>
        </div>
      </form>
    </div>
  );
}
