import { useEffect, useRef, useState } from 'react';

const IDLE_EVENTS = ['mousedown', 'mousemove', 'touchstart', 'scroll', 'keydown'] as const;

export function useIdleDetector(timeoutMs: number, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    function resetTimer() {
      setIdle(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setIdle(true), timeoutMs);
    }

    resetTimer();

    for (const event of IDLE_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of IDLE_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [timeoutMs, enabled]);

  return idle;
}
