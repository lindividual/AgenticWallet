import type { ReactNode } from 'react';

type AssetListItemProps = {
  className?: string;
  leftIcon?: ReactNode;
  leftPrimary?: ReactNode;
  leftSecondary?: ReactNode;
  rightPrimary?: ReactNode;
  rightSecondary?: ReactNode;
};

export function AssetListItem({
  className = 'bg-base-100 py-4',
  leftIcon,
  leftPrimary,
  leftSecondary,
  rightPrimary,
  rightSecondary,
}: AssetListItemProps) {
  const hasLeftText = Boolean(leftPrimary) || Boolean(leftSecondary);
  const hasRightText = Boolean(rightPrimary) || Boolean(rightSecondary);
  const hasLeft = Boolean(leftIcon) || hasLeftText;

  return (
    <article className={className}>
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
          <div className="min-w-0 text-right">
            {rightPrimary ? (
              <p className="m-0 break-words text-base font-semibold">
                {rightPrimary}
              </p>
            ) : null}
            {rightSecondary ? (
              <p className="m-0 break-words text-sm text-base-content/60">
                {rightSecondary}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
