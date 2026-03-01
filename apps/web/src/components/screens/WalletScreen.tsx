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

function getAssetInitial(asset: SimEvmBalance): string {
  const label = (asset.symbol ?? asset.name ?? '').trim();
  if (!label) return '?';
  return label[0].toUpperCase();
}

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

  const holdings = useMemo<SimEvmBalance[]>(() => {
    if (!data) {
      return [];
    }

    return [...data.holdings]
      .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
      .slice(0, 10);
  }, [data]);

  const totalBalance = data?.totalUsd ?? 0;
  const supportedChains = appConfig?.supportedChains ?? [];

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
            key={`${asset.chain_id}-${asset.address}`}
            onClick={() => openTransferModalFromAsset(asset)}
            leftIcon={
              asset.logo ? (
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
              )
            }
            leftPrimary={asset.symbol ?? asset.name ?? t('wallet.unknownAsset')}
            leftSecondary={asset.name ?? t('wallet.token')}
            rightPrimary={formatUsdAdaptive(Number(asset.value_usd ?? 0), i18n.language)}
            rightSecondary={formatTokenAmount(asset.amount, asset.decimals)}
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
