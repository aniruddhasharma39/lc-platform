import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  title?: string;
  duration?: number;
}

export interface ToastContextType {
  toasts: ToastItem[];
  showToast: (message: string, type?: ToastType, options?: { title?: string; duration?: number }) => string;
  success: (message: string, title?: string) => string;
  error: (message: string, title?: string) => string;
  warning: (message: string, title?: string) => string;
  info: (message: string, title?: string) => string;
  loading: (message: string, title?: string) => string;
  resolveToast: (id: string, message: string, type: ToastType, title?: string, duration?: number) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Standalone dispatcher for usage outside of React components (e.g. api.ts interceptor)
export const toast = {
  show: (message: string, type: ToastType = 'info', title?: string, duration?: number) => {
    window.dispatchEvent(
      new CustomEvent('app:toast', {
        detail: { message, type, title, duration },
      })
    );
  },
  success: (message: string, title?: string, duration?: number) =>
    toast.show(message, 'success', title, duration),
  error: (message: string, title?: string, duration?: number) =>
    toast.show(message, 'error', title, duration),
  warning: (message: string, title?: string, duration?: number) =>
    toast.show(message, 'warning', title, duration),
  info: (message: string, title?: string, duration?: number) =>
    toast.show(message, 'info', title, duration),
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', options?: { title?: string; duration?: number }): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const duration = options?.duration ?? (type === 'loading' ? 0 : 4500);
      const newToast: ToastItem = {
        id,
        message,
        type,
        title: options?.title,
        duration,
      };

      setToasts(prev => {
        // Limit to max 5 concurrent toasts to avoid clutter
        const updated = [...prev, newToast];
        return updated.length > 5 ? updated.slice(updated.length - 5) : updated;
      });

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, duration);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  const resolveToast = useCallback(
    (
      id: string,
      message: string,
      type: ToastType,
      title?: string,
      duration?: number
    ) => {
      const effectiveDuration = duration ?? (type === 'loading' ? 0 : 4500);
      const existingTimer = timersRef.current.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timersRef.current.delete(id);
      }

      setToasts(prev => {
        const exists = prev.some(t => t.id === id);
        if (!exists) {
          const fallbackToast: ToastItem = { id, message, type, title, duration: effectiveDuration };
          const updated = [...prev, fallbackToast];
          return updated.length > 5 ? updated.slice(updated.length - 5) : updated;
        }
        return prev.map(t => (t.id === id ? { ...t, message, type, title, duration: effectiveDuration } : t));
      });

      if (effectiveDuration > 0) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, effectiveDuration);
        timersRef.current.set(id, timer);
      }
    },
    [dismiss]
  );

  const success = useCallback((message: string, title?: string) => showToast(message, 'success', { title }), [showToast]);
  const error = useCallback((message: string, title?: string) => showToast(message, 'error', { title }), [showToast]);
  const warning = useCallback((message: string, title?: string) => showToast(message, 'warning', { title }), [showToast]);
  const info = useCallback((message: string, title?: string) => showToast(message, 'info', { title }), [showToast]);
  const loading = useCallback((message: string, title?: string) => showToast(message, 'loading', { title, duration: 0 }), [showToast]);

  // Listen for non-React static toast dispatches from window
  useEffect(() => {
    const handleAppToast = (e: Event) => {
      const customEvent = e as CustomEvent<{
        message: string;
        type?: ToastType;
        title?: string;
        duration?: number;
      }>;
      if (customEvent.detail?.message) {
        showToast(customEvent.detail.message, customEvent.detail.type || 'info', {
          title: customEvent.detail.title,
          duration: customEvent.detail.duration,
        });
      }
    };

    window.addEventListener('app:toast', handleAppToast);
    return () => {
      window.removeEventListener('app:toast', handleAppToast);
    };
  }, [showToast]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast, success, error, warning, info, loading, resolveToast, dismiss }}>
      {children}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
