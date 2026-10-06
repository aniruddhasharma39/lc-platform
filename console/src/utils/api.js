import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
});

// Request interceptor to add the access token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle token rotation
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const refreshToken = localStorage.getItem('refreshToken');
        const res = await axios.post(`${api.defaults.baseURL}/auth/refresh`, { token: refreshToken });
        
        if (res.status === 200) {
          localStorage.setItem('accessToken', res.data.accessToken);
          api.defaults.headers.common['Authorization'] = `Bearer ${res.data.accessToken}`;
          return api(originalRequest);
        }
      } catch (refreshError) {
        // Handle failed refresh (e.g., logout user)
        console.error('Session expired. Please login again.');
      }
    }
    return Promise.reject(error);
  }
);

export default api;
