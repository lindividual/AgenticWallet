import type { ReactNode } from 'react';
import { getMorphStyle, type RectSnapshot } from './morphTransition';

type ModalProps = {
  visible: boolean;
  originRect: RectSnapshot | null;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ visible, originRect, onClose, children }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-40 bg-base-200 transition-[transform] duration-300 ease-out"
      style={getMorphStyle(originRect, visible)}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <section
        className={`mx-auto flex h-screen w-full max-w-[420px] flex-col overflow-hidden bg-base-200 p-6 transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {children}
      </section>
    </div>
  );
}
