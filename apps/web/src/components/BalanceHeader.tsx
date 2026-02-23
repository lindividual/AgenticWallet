type BalanceHeaderProps = {
  title: string;
  balanceLabel: string;
  totalBalance: number;
  locale: string;
};

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function BalanceHeader({ title, balanceLabel, totalBalance, locale }: BalanceHeaderProps) {
  return (
    <>
      <header>
        <h1 className="m-0 text-2xl my-4 font-bold tracking-tight">{title}</h1>
      </header>
      <section>
        <p className="m-0 text-base text-base-content/60">{balanceLabel}</p>
        <p className="m-0 mt-1 text-4xl font-bold leading-none">{formatUsd(totalBalance, locale)}</p>
      </section>
    </>
  );
}
