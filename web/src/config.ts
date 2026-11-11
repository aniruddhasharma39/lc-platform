const fallbackUrl = import.meta.env.DEV ? 'http://localhost:5001' : 'http://13.234.106.118:5000';
const rawUrl = (import.meta.env.VITE_API_URL || fallbackUrl).trim();
export const API_URL = rawUrl.replace(/\/+$/, '');
