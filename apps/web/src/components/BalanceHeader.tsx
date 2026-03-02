import type { ReactNode } from 'react';
import { formatUsdAdaptive } from '../utils/currency';

type BalanceHeaderProps = {
  title: string;
  balanceLabel: string;
  totalBalance: number;
  locale: string;
  isBalanceLoading?: boolean;
  rightAction?: ReactNode;
};

export function BalanceHeader({
  title,
  balanceLabel,
  totalBalance,
  locale,
  isBalanceLoading = false,
  rightAction,
}: BalanceHeaderProps) {
  return (
    <>
      <header className="flex items-center justify-between gap-3">
        <h1 className="m-0 text-2xl mt-4 font-bold tracking-tight">{title}</h1>
        {rightAction ? <div className="shrink-0">{rightAction}</div> : null}
      </header>
      <section>
        <p className="m-0 text-base text-base-content/60">{balanceLabel}</p>
        <p className="m-0 mt-1 text-4xl font-bold leading-none">{isBalanceLoading ? '--' : formatUsdAdaptive(totalBalance, locale)}</p>
      </section>
    </>
  );
}
