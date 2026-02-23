import { useTranslation } from 'react-i18next';

export function TradeScreen() {
  const { t } = useTranslation();

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
      <header>
        <h1 className="m-0 text-2xl my-4 font-bold tracking-tight">{t('trade.title')}</h1>
      </header>
    </section>
  );
}
