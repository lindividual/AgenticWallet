import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

const AUTO_DISMISS_MS = 2000;
type ToastVariant = 'error' | 'success' | 'info';

type ToastState = {
  message: string;
  variant: ToastVariant;
  visible: boolean;
} | null;

type ToastContextValue = {
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  showInfo: (message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (variant: ToastVariant, message: string) => {
      clearTimer();
      setToast({ message, variant, visible: true });
      timerRef.current = setTimeout(dismiss, AUTO_DISMISS_MS);
    },
    [clearTimer, dismiss],
  );

  const showError = useCallback((message: string) => showToast('error', message), [showToast]);
  const showSuccess = useCallback((message: string) => showToast('success', message), [showToast]);
  const showInfo = useCallback((message: string) => showToast('info', message), [showToast]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const value = { showError, showSuccess, showInfo };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast && (
        <ErrorToast
          message={toast.message}
          variant={toast.variant}
          onClose={dismiss}
        />
      )}
    </ToastContext.Provider>
  );
}

function ErrorToast({
  message,
  variant,
  onClose,
}: {
  message: string;
  variant: ToastVariant;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const variantClass =
    variant === 'error'
      ? 'border-error/30'
      : variant === 'success'
        ? 'border-success/30'
        : 'border-info/30';
  const iconClass =
    variant === 'error' ? 'text-error' : variant === 'success' ? 'text-success' : 'text-info';
  const icon = variant === 'error' ? '!' : variant === 'success' ? '✓' : 'i';

  return (
    <div
      role="alert"
      className={`fixed right-4 top-4 z-50 flex min-w-[280px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-2xl border bg-base-100 p-4 shadow-xl ${variantClass}`}
    >
      <span className={`${iconClass} text-lg`} aria-hidden>
        {icon}
      </span>
      <p className="flex-1 text-sm text-base-content">{message}</p>
      <button
        type="button"
        aria-label={t('common.close')}
        className="btn btn-ghost btn-sm btn-circle"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
