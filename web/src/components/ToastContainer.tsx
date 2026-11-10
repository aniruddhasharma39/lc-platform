import React from 'react';
import { useToast, type ToastType } from '../context/ToastContext';
import {
  FaCheckCircle,
  FaTimesCircle,
  FaExclamationTriangle,
  FaInfoCircle,
  FaTimes,
  FaSpinner,
} from 'react-icons/fa';
import './Toast.css';

const getToastIcon = (type: ToastType) => {
  switch (type) {
    case 'success':
      return <FaCheckCircle />;
    case 'error':
      return <FaTimesCircle />;
    case 'warning':
      return <FaExclamationTriangle />;
    case 'loading':
      return <FaSpinner className="toast-spinner" />;
    case 'info':
    default:
      return <FaInfoCircle />;
  }
};

const getDefaultTitle = (type: ToastType) => {
  switch (type) {
    case 'success':
      return 'Success';
    case 'error':
      return 'Action Failed';
    case 'warning':
      return 'Attention';
    case 'loading':
      return 'In Progress';
    case 'info':
    default:
      return 'Notice';
  }
};

export const ToastContainer: React.FC = () => {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast-card ${t.type}`}
          role="alert"
        >
          <div className="toast-icon">{getToastIcon(t.type)}</div>
          <div className="toast-body">
            <div className="toast-title">{t.title || getDefaultTitle(t.type)}</div>
            <div className="toast-message">{t.message}</div>
          </div>
          <button
            type="button"
            className="toast-close-btn"
            onClick={() => dismiss(t.id)}
            aria-label="Close notification"
          >
            <FaTimes size={13} />
          </button>
        </div>
      ))}
    </div>
  );
};
