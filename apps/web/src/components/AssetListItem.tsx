import type { ReactNode } from 'react';

type AssetListItemProps = {
  className?: string;
  onClick?: () => void;
  leftIcon?: ReactNode;
  leftPrimary?: ReactNode;
  leftSecondary?: ReactNode;
  rightPrimary?: ReactNode;
  rightSecondary?: ReactNode;
};

export function AssetListItem({
  className = 'bg-base-100 py-4',
  onClick,
  leftIcon,
  leftPrimary,
  leftSecondary,
  rightPrimary,
  rightSecondary,
}: AssetListItemProps) {
  const hasLeftText = Boolean(leftPrimary) || Boolean(leftSecondary);
  const hasRightText = Boolean(rightPrimary) || Boolean(rightSecondary);
  const hasLeft = Boolean(leftIcon) || hasLeftText;
  const interactiveClassName = onClick
    ? 'w-full cursor-pointer text-left transition-colors hover:bg-base-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
    : '';
  const rootClassName = [className, interactiveClassName].filter(Boolean).join(' ');

  const content = (
    <div className={rootClassName}>
      <div className="flex items-center justify-between gap-3">
        {hasLeft ? (
          <div className="flex min-w-0 items-center gap-3">
            {leftIcon ? <div className="shrink-0">{leftIcon}</div> : null}
            {hasLeftText ? (
              <div className="min-w-0">
                {leftPrimary ? (
                  <p className="m-0 truncate text-base font-semibold">
                    {leftPrimary}
                  </p>
                ) : null}
                {leftSecondary ? (
                  <p className="m-0 truncate text-sm text-base-content/60">
                    {leftSecondary}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {hasRightText ? (
          <div className="shrink-0 text-right">
            {rightPrimary ? (
              <p className="m-0 whitespace-nowrap text-base font-semibold tabular-nums">
                {rightPrimary}
              </p>
            ) : null}
            {rightSecondary ? (
              <p className="m-0 whitespace-nowrap text-sm text-base-content/60 tabular-nums">
                {rightSecondary}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="w-full border-0 bg-transparent p-0">
        {content}
      </button>
    );
  }

  return <article>{content}</article>;
}
