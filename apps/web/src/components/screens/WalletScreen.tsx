import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getWalletPortfolio, type SimEvmBalance } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import type { AuthState } from '../../hooks/useWalletApp';

type WalletScreenProps = {
  auth: AuthState;
};

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTokenAmount(rawAmount: string | undefined, decimals: number | undefined): string {
  const amount = Number(rawAmount ?? 0);
  if (!Number.isFinite(amount)) return '0';

  const divisor = 10 ** (decimals ?? 0);
  const normalized = divisor > 0 ? amount / divisor : amount;
  return normalized.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function getAssetInitial(asset: SimEvmBalance): string {
  const label = (asset.symbol ?? asset.name ?? '').trim();
  if (!label) return '?';
  return label[0].toUpperCase();
}

export function WalletScreen({ auth }: WalletScreenProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [topUpView, setTopUpView] = useState<'menu' | 'receive' | 'buy' | null>(null);
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';
  const dailyReport = t('wallet.dailyReportMock');

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const holdings = useMemo<SimEvmBalance[]>(() => {
    if (!data) {
      return [];
    }

    return [...data.holdings]
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .slice(0, 10);
  }, [data]);

  const totalBalance = data?.totalUsd ?? 0;

  useEffect(() => {
    if (!walletAddress) {
      console.log('[wallet-ui] no walletAddress in auth payload');
      return;
    }
    console.log('[wallet-ui] query_state', {
      walletAddress,
      isLoading,
      isFetching,
      isError,
      error: isError ? (error as Error)?.message : null,
    });
  }, [walletAddress, isLoading, isFetching, isError, error]);

  useEffect(() => {
    if (!data) return;
    console.log('[wallet-ui] portfolio_response', {
      walletAddress: data.walletAddress,
      totalUsd: data.totalUsd,
      holdingsCount: data.holdings.length,
      sample: data.holdings.slice(0, 3).map((row) => ({
        chain_id: row.chain_id,
        symbol: row.symbol,
        amount: row.amount,
        value_usd: row.value_usd ?? null,
      })),
    });
  }, [data]);

  async function handleCopyAddress() {
    if (!walletAddress) {
      showError(t('wallet.addressUnavailable'));
      return;
    }

    try {
      await navigator.clipboard.writeText(walletAddress);
      showSuccess(t('wallet.addressCopied'));
    } catch (err) {
      showError(`${t('common.error')}: ${(err as Error).message}`);
    }
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col gap-5 p-6">
      <header>
        <h1 className="m-0 text-xl font-bold tracking-tight">{t('wallet.title')}</h1>
      </header>

      <section>
        <p className="m-0 text-base text-base-content/60">{t('wallet.balance')}</p>
        <p className="m-0 mt-1 text-3xl font-bold leading-none">{formatUsd(totalBalance, i18n.language)}</p>
      </section>

      <section className="grid grid-cols-3 gap-3">
        <button
          type="button"
          className="btn btn-primary h-16 text-base font-semibold"
          onClick={() => setTopUpView('menu')}
        >
          {t('wallet.topUp')}
        </button>
        <button type="button" className="btn btn-primary h-16 text-base font-semibold">
          {t('wallet.transfer')}
        </button>
        <button type="button" className="btn btn-primary h-16 text-base font-semibold">
          {t('wallet.trade')}
        </button>
      </section>

      <section className="border border-base-400 bg-base-100 p-4">
        <h2 className="m-0 text-lg font-bold">{t('wallet.today')}</h2>
        <p className="m-0 mt-2 text-base leading-snug">{dailyReport}</p>
        <p className="m-0 mt-2 text-sm text-base-content/50">{t('wallet.generatedByAgent')}</p>
        <div className="mt-2 flex items-center justify-between border-t border-base-400 pt-3 text-sm">
          <button type="button" className="link">
            {t('wallet.moreReadings')}
          </button>
          <button type="button" className="link">
            {t('wallet.saved')}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-xl font-bold">{t('wallet.holdings')}</h2>
          <button
            type="button"
            className="btn btn-outline btn-sm h-8 min-h-0 px-3"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? t('wallet.refreshing') : t('wallet.refresh')}
          </button>
        </div>

        {isLoading && (
          <div className="border border-base-400 bg-base-100 p-4 text-xl">{t('wallet.loadingAssets')}</div>
        )}
        {isError && (
          <div className="border border-error bg-error/10 p-4 text-xl text-error">
            {t('wallet.failedToLoadAssets', { message: (error as Error).message })}
          </div>
        )}
        {!isLoading && !isError && holdings.length === 0 && (
          <div className="bg-base-200 p-4 text-base">{t('wallet.noAssetsFound')}</div>
        )}
        {holdings.map((asset) => (
          <article key={`${asset.chain_id}-${asset.address}`} className="border border-base-400 bg-base-100 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {asset.logo ? (
                  <img
                    src={asset.logo}
                    alt={asset.symbol ?? asset.name ?? t('wallet.token')}
                    className="h-10 w-10 rounded-full bg-base-300 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                    {getAssetInitial(asset)}
                  </div>
                )}
                <div>
                  <p className="m-0 text-base font-semibold">{asset.symbol ?? asset.name ?? t('wallet.unknownAsset')}</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">{asset.name ?? t('wallet.token')}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="m-0 text-base font-semibold">
                  {formatUsd(Number(asset.value_usd ?? 0), i18n.language)}
                </p>
                <p className="m-0 mt-1 text-sm text-base-content/60">
                  {formatTokenAmount(asset.amount, asset.decimals)}
                </p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {topUpView && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setTopUpView(null)}
          role="presentation"
        >
          <section
            className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col bg-base-200 p-6 pt-24"
            onClick={(event) => event.stopPropagation()}
          >
            {topUpView === 'menu' && (
              <>
                <header className="flex items-start justify-between">
                  <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.topUpTitle')}</h2>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm h-9 min-h-0 px-3 text-xl"
                    aria-label={t('common.close')}
                    onClick={() => setTopUpView(null)}
                  >
                    ×
                  </button>
                </header>

                <div className="mt-16 flex flex-col gap-4">
                  <button
                    type="button"
                    className="flex items-center gap-4 border border-base-300 bg-base-100 px-4 py-5 text-left text-3xl font-semibold"
                    onClick={() => setTopUpView('receive')}
                  >
                    <span aria-hidden>↓</span>
                    <span>{t('wallet.receiveCrypto')}</span>
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-4 border border-base-300 bg-base-100 px-4 py-5 text-left text-3xl font-semibold"
                    onClick={() => setTopUpView('buy')}
                  >
                    <span aria-hidden>$</span>
                    <span>{t('wallet.buyCrypto')}</span>
                  </button>
                </div>
              </>
            )}

            {topUpView === 'receive' && (
              <>
                <header className="flex items-start justify-between">
                  <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.receiveCryptoTitle')}</h2>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm h-9 min-h-0 px-3 text-xl"
                    aria-label={t('common.close')}
                    onClick={() => setTopUpView(null)}
                  >
                    ×
                  </button>
                </header>

                <div className="mt-16 flex flex-col gap-4 border border-base-300 bg-base-100 p-5">
                  <p className="m-0 text-xl font-medium break-all">{walletAddress || t('wallet.addressUnavailable')}</p>
                  <button
                    type="button"
                    className="btn btn-primary h-12 w-fit px-6 text-xl font-semibold"
                    onClick={handleCopyAddress}
                  >
                    {t('wallet.copy')}
                  </button>
                </div>

                <button
                  type="button"
                  className="mt-10 w-fit text-4xl"
                  onClick={() => setTopUpView('menu')}
                  aria-label={t('wallet.back')}
                >
                  ←
                </button>
              </>
            )}

            {topUpView === 'buy' && (
              <>
                <header className="flex items-start justify-between">
                  <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.buyCrypto')}</h2>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm h-9 min-h-0 px-3 text-xl"
                    aria-label={t('common.close')}
                    onClick={() => setTopUpView(null)}
                  >
                    ×
                  </button>
                </header>

                <div className="mt-16 border border-base-300 bg-base-100 p-5">
                  <p className="m-0 text-2xl font-medium">{t('wallet.buyComingSoon')}</p>
                </div>

                <button
                  type="button"
                  className="mt-10 w-fit text-4xl"
                  onClick={() => setTopUpView('menu')}
                  aria-label={t('wallet.back')}
                >
                  ←
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
