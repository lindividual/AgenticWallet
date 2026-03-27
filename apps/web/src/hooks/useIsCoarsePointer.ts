import { useEffect, useState } from 'react';

const COARSE_POINTER_MEDIA_QUERY = '(hover: none) and (pointer: coarse)';

function getIsCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COARSE_POINTER_MEDIA_QUERY).matches;
}

export function useIsCoarsePointer(): boolean {
  const [isCoarsePointer, setIsCoarsePointer] = useState<boolean>(() => getIsCoarsePointer());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia(COARSE_POINTER_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCoarsePointer(event.matches);
    };

    setIsCoarsePointer(mediaQuery.matches);

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  return isCoarsePointer;
}
