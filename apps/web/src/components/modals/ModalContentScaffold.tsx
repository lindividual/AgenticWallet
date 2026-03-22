import type { MouseEventHandler, ReactNode } from 'react';
import { ArrowLeft, X } from 'lucide-react';

type ModalContentScaffoldProps = {
  title: ReactNode;
  headerMeta?: ReactNode;
  bodyClassName?: string;
  contentClassName?: string;
  stageClassName?: string;
  showBack?: boolean;
  onBack?: MouseEventHandler<HTMLButtonElement>;
  backAriaLabel?: string;
  onClose: MouseEventHandler<HTMLButtonElement>;
  closeAriaLabel: string;
  hideFooter?: boolean;
  footerVisible?: boolean;
  children: ReactNode;
};

export function ModalContentScaffold({
  title,
  headerMeta,
  bodyClassName = 'justify-start',
  contentClassName = 'mt-8 flex min-h-0 flex-1 flex-col',
  stageClassName = '',
  showBack = false,
  onBack,
  backAriaLabel,
  onClose,
  closeAriaLabel,
  hideFooter = false,
  footerVisible = true,
  children,
}: ModalContentScaffoldProps) {
  return (
    <div className="flex min-h-full w-full flex-col">
      <div className={`flex min-h-0 w-full flex-1 flex-col ${bodyClassName} ${stageClassName}`.trim()}>
        <header>
          <h2 className="m-0 text-4xl font-bold tracking-tight">{title}</h2>
          {headerMeta ? <div className="mt-3">{headerMeta}</div> : null}
        </header>

        <div className={contentClassName}>{children}</div>
      </div>

      {hideFooter || !footerVisible ? null : (
        <div className="relative mt-auto flex items-center justify-center pt-6">
          {showBack && onBack ? (
            <button
              type="button"
              className="btn btn-ghost absolute left-0 h-12 w-12 p-0 transition-none"
              onClick={onBack}
              aria-label={backAriaLabel}
            >
              <ArrowLeft size={32} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost h-12 w-12 p-0 transition-none"
            aria-label={closeAriaLabel}
            onClick={onClose}
          >
            <X size={26} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
