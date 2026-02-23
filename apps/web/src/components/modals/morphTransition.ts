import type { CSSProperties } from 'react';

export type RectSnapshot = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function snapshotRect(element: Element | null): RectSnapshot | null {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function getMorphStyle(originRect: RectSnapshot | null, visible: boolean): CSSProperties {
  if (!originRect || typeof window === 'undefined') {
    return {};
  }

  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  const width = Math.max(originRect.width, 1);
  const height = Math.max(originRect.height, 1);
  const collapsedTransform = `translate(${originRect.left}px, ${originRect.top}px) scale(${width / viewportWidth}, ${height / viewportHeight})`;

  return {
    transformOrigin: 'top left',
    transform: visible ? 'translate(0px, 0px) scale(1, 1)' : collapsedTransform,
  };
}
