import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getAppConfig, getWalletPortfolio, type SimEvmBalance, type TransferRecord } from '../../api';
import { Modal } from '../modals/Modal';
import { ReceiveCryptoContent } from '../modals/ReceiveCryptoContent';
import { TopUpContent } from '../modals/TopUpContent';
import { TransferContent } from '../modals/TransferContent';
import { snapshotRect, type RectSnapshot } from '../modals/morphTransition';
import { useToast } from '../../contexts/ToastContext';
import type { AuthState } from '../../hooks/useWalletApp';
import { AssetListItem } from '../AssetListItem';
import { BalanceHeader } from '../BalanceHeader';
import { formatUsdAdaptive } from '../../utils/currency';
import { SettingsDropdown } from '../SettingsDropdown';

type WalletScreenProps = {
  auth: AuthState;
  onLogout: () => void;
};

type ActiveModalContent = 'topUp' | 'receive' | 'transfer';
type TransferPresetAsset = {
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
};

function formatTokenAmount(rawAmount: string | undefined, decimals: number | undefined): string {
  const amount = Number(rawAmount ?? 0);
  if (!Number.isFinite(amount)) return '0';

  const divisor = 10 ** (decimals ?? 0);
  const normalized = divisor > 0 ? amount / divisor : amount;
  return normalized.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function getAssetInitial(symbol: string | null | undefined, name: string | null | undefined): string {
  const label = (symbol ?? name ?? '').trim();
  if (!label) return '?';
  return label[0].toUpperCase();
}

type WalletHoldingListItem = {
  key: string;
  symbol: string;
  name: string;
  logo: string | null;
  valueUsd: number;
  amountText: string;
  secondaryLabel: string;
  transferAsset: SimEvmBalance;
};

export function WalletScreen({ auth, onLogout }: WalletScreenProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [activeModalContent, setActiveModalContent] = useState<ActiveModalContent>('topUp');
  const [modalVisible, setModalVisible] = useState(false);
  const [modalOriginRect, setModalOriginRect] = useState<RectSnapshot | null>(null);
  const [presetTransferAsset, setPresetTransferAsset] = useState<TransferPresetAsset | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRafRef = useRef<number | null>(null);
  const topUpButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferButtonRef = useRef<HTMLButtonElement | null>(null);
  const walletAddress = auth.wallet?.address ?? auth.wallet?.chainAccounts?.[0]?.address ?? '';

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['wallet-portfolio', walletAddress],
    queryFn: () => getWalletPortfolio(),
    enabled: Boolean(walletAddress),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const { data: appConfig } = useQuery({
    queryKey: ['app-config'],
    queryFn: getAppConfig,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const totalBalance = data?.totalUsd ?? 0;
  const supportedChains = appConfig?.supportedChains ?? [];
  const chainNameById = useMemo(
    () => new Map(supportedChains.map((chain) => [chain.chainId, chain.name] as const)),
    [supportedChains],
  );

  const holdings = useMemo<WalletHoldingListItem[]>(() => {
    if (!data) {
      return [];
    }

    const merged = data.mergedHoldings ?? [];
    if (merged.length > 0) {
      return [...merged]
        .sort((a, b) => Number(b.total_value_usd ?? 0) - Number(a.total_value_usd ?? 0))
        .slice(0, 10)
        .flatMap((item) => {
          const variants = [...(item.variants ?? [])].sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0));
          const primary = variants[0];
          if (!primary) return [];

          const chainLabels = [
            ...new Set(
              variants
                .map((variant) => {
                  const fromConfig = chainNameById.get(Number(variant.chain_id));
                  if (fromConfig) return fromConfig;
                  if (variant.chain) return variant.chain.toUpperCase();
                  const fallbackChainId = Number(variant.chain_id);
                  return Number.isFinite(fallbackChainId) ? String(fallbackChainId) : '--';
                })
                .filter(Boolean),
            ),
          ];
          const chainSummary =
            chainLabels.length > 1
              ? t('wallet.multiChainCount', { count: chainLabels.length })
              : t('wallet.singleChainLabel', { chain: chainLabels[0] ?? '--' });
          const symbol = (item.symbol ?? primary.symbol ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
          const name = (item.name ?? primary.name ?? t('wallet.token')).trim();

          return [
            {
              key: item.asset_id || `${primary.chain_id}-${primary.address}`,
              symbol,
              name,
              logo: item.logo ?? primary.logo ?? null,
              valueUsd: Number(item.total_value_usd ?? primary.value_usd ?? 0),
              amountText:
                chainLabels.length > 1
                  ? t('wallet.multiChainCount', { count: chainLabels.length })
                  : formatTokenAmount(primary.amount, primary.decimals),
              secondaryLabel: `${name} · ${chainSummary}`,
              transferAsset: primary,
            } satisfies WalletHoldingListItem,
          ];
        });
    }

    return [...data.holdings]
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .slice(0, 10)
      .map((asset) => {
        const chainName =
          chainNameById.get(Number(asset.chain_id))
          ?? asset.chain?.toUpperCase()
          ?? (Number.isFinite(Number(asset.chain_id)) ? String(asset.chain_id) : '--');
        const symbol = (asset.symbol ?? asset.name ?? '').trim().toUpperCase() || t('wallet.unknownAsset');
        const name = (asset.name ?? t('wallet.token')).trim();
        return {
          key: `${asset.chain_id}-${asset.address}`,
          symbol,
          name,
          logo: asset.logo ?? null,
          valueUsd: Number(asset.value_usd ?? 0),
          amountText: formatTokenAmount(asset.amount, asset.decimals),
          secondaryLabel: `${name} · ${t('wallet.singleChainLabel', { chain: chainName })}`,
          transferAsset: asset,
        } satisfies WalletHoldingListItem;
      });
  }, [chainNameById, data, t]);

  useEffect(
    () => () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
      if (openRafRef.current !== null) {
        cancelAnimationFrame(openRafRef.current);
      }
    },
    [],
  );

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

  function showModal(originRect: RectSnapshot | null) {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openRafRef.current !== null) {
      cancelAnimationFrame(openRafRef.current);
    }

    setIsModalOpen(true);
    setModalOriginRect(originRect);
    setModalVisible(false);
    openRafRef.current = requestAnimationFrame(() => {
      setModalVisible(true);
      openRafRef.current = null;
    });
  }

  function openTopUpModal() {
    setActiveModalContent('topUp');
    showModal(snapshotRect(topUpButtonRef.current));
  }

  function openTransferModal() {
    setPresetTransferAsset(null);
    setActiveModalContent('transfer');
    showModal(snapshotRect(transferButtonRef.current));
  }

  function openTransferModalFromAsset(asset: SimEvmBalance) {
    const tokenAddress = asset.address?.trim();
    const isValidTokenAddress = /^0x[a-fA-F0-9]{40}$/.test(tokenAddress ?? '');
    const isZeroAddress = (tokenAddress ?? '').toLowerCase() === '0x0000000000000000000000000000000000000000';
    const shouldPresetToken = isValidTokenAddress && !isZeroAddress;

    setPresetTransferAsset(
      shouldPresetToken
        ? {
            chainId: asset.chain_id,
            tokenAddress: tokenAddress!,
            tokenSymbol: asset.symbol,
            tokenDecimals: asset.decimals,
          }
        : null,
    );
    setActiveModalContent('transfer');
    showModal(null);
  }

  function openReceiveModal() {
    setActiveModalContent('receive');
  }

  function backToTopUp() {
    setActiveModalContent('topUp');
  }

  function closeActiveModal() {
    if (!isModalOpen) return;

    setModalVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      setIsModalOpen(false);
      closeTimerRef.current = null;
    }, 300);
  }

  function handleTransferSubmitted(transfer: TransferRecord) {
    console.log('[wallet-ui] transfer_submitted', {
      id: transfer.id,
      status: transfer.status,
      txHash: transfer.txHash,
      chainId: transfer.chainId,
    });
    void refetch();
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-28">
      <BalanceHeader
        title={t('wallet.title')}
        balanceLabel={t('wallet.balance')}
        totalBalance={totalBalance}
        locale={i18n.language}
        rightAction={<SettingsDropdown onLogout={onLogout} />}
      />

      <section className="grid grid-cols-3 gap-3 mt-6">
        <button
          ref={topUpButtonRef}
          type="button"
          className="btn btn-primary h-16 text-base font-semibold"
          onClick={openTopUpModal}
        >
          {t('wallet.topUp')}
        </button>
        <button
          ref={transferButtonRef}
          type="button"
          className="btn btn-primary h-16 text-base font-semibold"
          onClick={openTransferModal}
        >
          {t('wallet.transfer')}
        </button>
        <button type="button" className="btn btn-primary h-16 text-base font-semibold">
          {t('wallet.trade')}
        </button>
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
          <AssetListItem
            key={asset.key}
            onClick={() => openTransferModalFromAsset(asset.transferAsset)}
            leftIcon={
              asset.logo ? (
                <img
                  src={asset.logo}
                  alt={asset.symbol || asset.name || t('wallet.token')}
                  className="h-10 w-10 rounded-full bg-base-300 object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-base font-semibold text-base-content/70">
                  {getAssetInitial(asset.symbol, asset.name)}
                </div>
              )
            }
            leftPrimary={asset.symbol}
            leftSecondary={asset.secondaryLabel}
            rightPrimary={formatUsdAdaptive(asset.valueUsd, i18n.language)}
            rightSecondary={asset.amountText}
          />
        ))}
      </section>

      {isModalOpen && (
        <Modal visible={modalVisible} originRect={modalOriginRect} onClose={closeActiveModal}>
          <div className="relative flex-1 overflow-hidden">
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'topUp'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none -translate-x-4 opacity-0'
              }`}
            >
              <TopUpContent
                active={activeModalContent === 'topUp'}
                onOpenReceive={openReceiveModal}
                onClose={closeActiveModal}
              />
            </div>
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'receive'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              <ReceiveCryptoContent
                walletAddress={walletAddress}
                supportedChains={supportedChains}
                onBack={backToTopUp}
                onCopyAddress={() => {
                  void handleCopyAddress();
                }}
                onClose={closeActiveModal}
              />
            </div>
            <div
              className={`absolute inset-0 transition-all duration-300 ${
                activeModalContent === 'transfer'
                  ? 'translate-x-0 opacity-100'
                  : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              <TransferContent
                active={activeModalContent === 'transfer'}
                presetAsset={presetTransferAsset}
                supportedChains={supportedChains}
                onBack={closeActiveModal}
                onClose={closeActiveModal}
                onSubmitted={handleTransferSubmitted}
              />
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
