import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { CheckCircle2, ChevronDown, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  quoteCrossChainTransfer,
  quoteTransfer,
  submitCrossChainTransfer,
  submitTransfer,
  type CrossChainTransferQuoteResponse,
  type CrossChainTransferSourceOption,
  type CrossChainTransferSubmitResponse,
  type SupportedStablecoinSymbol,
  type TransferQuoteResponse,
  type TransferRecord,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { CachedIconImage } from '../CachedIconImage';
import type { TransferSelectableAsset } from '../../utils/transferAssets';
import { ModalContentScaffold } from './ModalContentScaffold';

type TransferEntryPoint = 'wallet' | 'asset-detail';

type TransferContentProps = {
  active: boolean;
  entryPoint: TransferEntryPoint;
  availableAssets: TransferSelectableAsset[];
  lockedAsset?: TransferSelectableAsset | null;
  supportedChains: Array<{
    networkKey: string;
    chainId: number | null;
    name: string;
    symbol: string;
  }>;
  onClose: () => void;
  onBack: () => void;
  onCompleted: () => void;
  footerVisible?: boolean;
  stageClassName?: string;
};

type TransferStep = 'asset' | 'recipient' | 'network' | 'amount' | 'review' | 'waiting' | 'result';

type TransferAssetOption = {
  key: string;
  symbol: string;
  name: string;
  logo: string | null;
  totalAmountText: string;
  totalValueUsd: number;
  variants: TransferSelectableAsset[];
};

type TransferDraft = {
  recipient: string;
  legacyNetworkKey: string;
  destinationNetworkKey: string;
  selectedSourceNetworkKey: string | null;
  selectedAssetOptionKey: string | null;
  selectedAsset: TransferSelectableAsset | null;
  amount: string;
  legacyQuote: TransferQuoteResponse | null;
  stablecoinQuote: CrossChainTransferQuoteResponse | null;
};

type TransferResultState =
  | {
      success: true;
      mode: 'legacy';
      transfer: TransferRecord;
    }
  | {
      success: true;
      mode: 'stable';
      result: CrossChainTransferSubmitResponse;
    }
  | {
      success: false;
      errorMessage: string;
    }
  | null;

const ASSET_STEP_FALLBACK_LABEL = 'T';
const STABLECOIN_SYMBOLS = new Set<SupportedStablecoinSymbol>(['USDT', 'USDC']);
const STABLECOIN_DESTINATION_NETWORK_KEYS = new Set([
  'ethereum-mainnet',
  'arbitrum-mainnet',
  'base-mainnet',
  'optimism-mainnet',
  'bnb-mainnet',
  'polygon-mainnet',
]);

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTokenAmount(rawAmount: string | null, decimals: number | null | undefined): string | null {
  if (!rawAmount) return null;
  const normalizedDecimals = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  if (normalizedDecimals < 0 || normalizedDecimals > 36) return null;
  try {
    const raw = BigInt(rawAmount);
    const divisor = 10n ** BigInt(normalizedDecimals);
    const whole = raw / divisor;
    const fraction = raw % divisor;
    if (fraction === 0n) return whole.toString();
    const fractionText = fraction.toString().padStart(normalizedDecimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fractionText}`;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number | null): string | null {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  const normalized = Math.round(Number(seconds));
  if (normalized < 60) return `${normalized}s`;
  const minutes = Math.round(normalized / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function getTransferAssetOptionKey(asset: TransferSelectableAsset): string {
  if (asset.assetId) return asset.assetId;
  if (asset.isNative) return `native:${asset.symbol}`;
  return `token:${asset.symbol}:${asset.name}`;
}

function sumRawAmounts(left: string, right: string): string {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return (BigInt(left) + BigInt(right)).toString();
  }
  const value = Number(left) + Number(right);
  return Number.isFinite(value) ? String(value) : left;
}

function getAssetFallbackLabel(label: string | null | undefined): string {
  const value = (label ?? '').trim();
  return value ? value[0]!.toUpperCase() : ASSET_STEP_FALLBACK_LABEL;
}

function getStablecoinSymbol(raw: string | null | undefined): SupportedStablecoinSymbol | null {
  const symbol = (raw ?? '').trim().toUpperCase();
  return STABLECOIN_SYMBOLS.has(symbol as SupportedStablecoinSymbol) ? symbol as SupportedStablecoinSymbol : null;
}

function buildStablecoinSubmitPayload(
  draft: TransferDraft,
  stablecoinSymbol: SupportedStablecoinSymbol,
) {
  return {
    toAddress: draft.recipient.trim(),
    destinationNetworkKey: draft.destinationNetworkKey,
    destinationTokenSymbol: stablecoinSymbol,
    amount: draft.amount.trim(),
    sourceNetworkKey: draft.selectedSourceNetworkKey ?? undefined,
  };
}

function AssetAvatar({
  src,
  label,
  alt,
}: {
  src: string | null;
  label: string;
  alt: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  if (!src || loadFailed) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/70">
        {getAssetFallbackLabel(label)}
      </div>
    );
  }

  return (
    <CachedIconImage
      src={src}
      alt={alt}
      className="h-10 w-10 rounded-full bg-base-300 object-cover"
      loading="lazy"
      onError={() => setLoadFailed(true)}
    />
  );
}

export function TransferContent({
  active,
  entryPoint,
  availableAssets,
  lockedAsset = null,
  supportedChains,
  onClose,
  onBack,
  onCompleted,
  footerVisible = true,
  stageClassName,
}: TransferContentProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const availableNetworkKeys = useMemo(
    () => new Set(availableAssets.map((asset) => asset.networkKey)),
    [availableAssets],
  );
  const selectableChains = useMemo(() => {
    if (entryPoint !== 'wallet' || availableNetworkKeys.size === 0) {
      return supportedChains;
    }
    return supportedChains.filter((chain) => availableNetworkKeys.has(chain.networkKey));
  }, [availableNetworkKeys, entryPoint, supportedChains]);
  const stablecoinDestinationChains = useMemo(
    () => supportedChains.filter((chain) => STABLECOIN_DESTINATION_NETWORK_KEYS.has(chain.networkKey)),
    [supportedChains],
  );
  const assetOptions = useMemo<TransferAssetOption[]>(() => {
    const byKey = new Map<string, TransferAssetOption>();

    for (const asset of availableAssets) {
      const key = getTransferAssetOptionKey(asset);
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, {
          key,
          symbol: asset.symbol,
          name: asset.name,
          logo: asset.logo,
          totalAmountText: asset.amountText,
          totalValueUsd: asset.valueUsd,
          variants: [asset],
        });
        continue;
      }

      const combinedRaw = [...current.variants, asset].reduce((sum, variant) => sumRawAmounts(sum, variant.amountRaw), '0');
      current.totalAmountText = formatTokenAmount(combinedRaw, current.variants[0]?.tokenDecimals ?? asset.tokenDecimals) ?? current.totalAmountText;
      current.totalValueUsd += asset.valueUsd;
      current.logo = current.logo ?? asset.logo;
      current.variants.push(asset);
    }

    return [...byKey.values()]
      .map((option) => ({
        ...option,
        variants: [...option.variants].sort((a, b) => b.valueUsd - a.valueUsd || a.networkKey.localeCompare(b.networkKey)),
      }))
      .sort((a, b) => b.totalValueUsd - a.totalValueUsd || a.symbol.localeCompare(b.symbol));
  }, [availableAssets]);
  const stepSequence = useMemo<TransferStep[]>(
    () => (entryPoint === 'wallet' ? ['asset', 'recipient', 'network', 'amount', 'review'] : ['recipient', 'network', 'amount', 'review']),
    [entryPoint],
  );

  const initialLegacyNetworkKey =
    lockedAsset?.networkKey ?? selectableChains[0]?.networkKey ?? supportedChains[0]?.networkKey ?? 'ethereum-mainnet';
  const initialDestinationNetworkKey =
    lockedAsset && getStablecoinSymbol(lockedAsset.symbol) && STABLECOIN_DESTINATION_NETWORK_KEYS.has(lockedAsset.networkKey)
      ? lockedAsset.networkKey
      : stablecoinDestinationChains[0]?.networkKey ?? initialLegacyNetworkKey;

  function createInitialDraft(): TransferDraft {
    return {
      recipient: '',
      legacyNetworkKey: initialLegacyNetworkKey,
      destinationNetworkKey: initialDestinationNetworkKey,
      selectedSourceNetworkKey: null,
      selectedAssetOptionKey: lockedAsset ? getTransferAssetOptionKey(lockedAsset) : null,
      selectedAsset: lockedAsset,
      amount: '',
      legacyQuote: null,
      stablecoinQuote: null,
    };
  }

  const [draft, setDraft] = useState<TransferDraft>(createInitialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [step, setStep] = useState<TransferStep>(stepSequence[0] ?? 'asset');
  const [resultState, setResultState] = useState<TransferResultState>(null);
  const [sourcePickerExpanded, setSourcePickerExpanded] = useState(false);

  const selectedAssetOption = useMemo(
    () => assetOptions.find((option) => option.key === draft.selectedAssetOptionKey) ?? null,
    [assetOptions, draft.selectedAssetOptionKey],
  );
  const selectedAsset = lockedAsset ?? draft.selectedAsset;
  const stablecoinSymbol = getStablecoinSymbol(selectedAssetOption?.symbol ?? selectedAsset?.symbol);
  const isStablecoinFlow = stablecoinSymbol !== null;
  const selectedLegacyChain = useMemo(
    () => supportedChains.find((item) => item.networkKey === draft.legacyNetworkKey) ?? supportedChains[0] ?? null,
    [draft.legacyNetworkKey, supportedChains],
  );
  const selectedDestinationChain = useMemo(
    () => stablecoinDestinationChains.find((item) => item.networkKey === draft.destinationNetworkKey) ?? stablecoinDestinationChains[0] ?? null,
    [draft.destinationNetworkKey, stablecoinDestinationChains],
  );
  const selectedChainLabel = isStablecoinFlow
    ? selectedDestinationChain?.name ?? draft.destinationNetworkKey
    : selectedLegacyChain?.name ?? draft.legacyNetworkKey;
  const networkOptions = useMemo(
    () => (selectedAssetOption?.variants ?? []).filter((asset) => selectableChains.some((chain) => chain.networkKey === asset.networkKey)),
    [selectableChains, selectedAssetOption?.variants],
  );
  const stepIndex = useMemo(() => {
    const interactiveIndex = stepSequence.indexOf(step);
    if (interactiveIndex >= 0) return interactiveIndex + 1;
    return stepSequence.length;
  }, [step, stepSequence]);

  useEffect(() => {
    if (!active) return;
    setDraft(createInitialDraft());
    setSubmitting(false);
    setQuoting(false);
    setStep(stepSequence[0] ?? 'asset');
    setResultState(null);
    setSourcePickerExpanded(false);
  }, [active, initialDestinationNetworkKey, initialLegacyNetworkKey, lockedAsset, stepSequence]);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  function getNetworkName(networkKey: string | null | undefined): string {
    if (!networkKey) return t('wallet.transferQuoteUnavailable');
    return supportedChains.find((item) => item.networkKey === networkKey)?.name ?? networkKey;
  }

  function getDisplayFeeText(nextQuote: TransferQuoteResponse): string {
    const fallbackSymbol = selectedAsset?.symbol ?? selectedLegacyChain?.symbol ?? nextQuote.tokenSymbol ?? '';
    const symbol = nextQuote.estimatedFeeTokenSymbol ?? fallbackSymbol;
    if (nextQuote.estimatedFeeTokenAmount) {
      return `${nextQuote.estimatedFeeTokenAmount} ${symbol}`.trim();
    }
    const normalized = formatTokenAmount(
      nextQuote.estimatedFeeTokenWei,
      nextQuote.estimatedFeeTokenDecimals ?? nextQuote.tokenDecimals,
    );
    if (normalized) return `${normalized} ${symbol}`.trim();
    return nextQuote.estimatedFeeWei ?? t('wallet.transferQuoteUnavailable');
  }

  function getStablecoinFeeText(nextQuote: CrossChainTransferQuoteResponse): string {
    const totals = nextQuote.legs.reduce(
      (acc, leg) => ({
        gas: acc.gas + Number(leg.estimatedGasCostUsd ?? 0),
        route: acc.route + Number(leg.estimatedFeeCostUsd ?? 0),
      }),
      { gas: 0, route: 0 },
    );
    const total = totals.gas + totals.route;
    if (!Number.isFinite(total) || total <= 0) return t('wallet.transferQuoteUnavailable');
    return `$${total.toFixed(2)}`;
  }

  async function quoteLegacyTransfer() {
    if (!selectedAsset) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }

    const requestPayload = {
      networkKey: draft.legacyNetworkKey,
      toAddress: draft.recipient.trim(),
      amount: draft.amount.trim(),
      tokenAddress: selectedAsset.isNative ? undefined : selectedAsset.tokenAddress,
      tokenSymbol: selectedAsset.symbol,
      tokenDecimals: selectedAsset.tokenDecimals,
    };

    setQuoting(true);
    try {
      const nextQuote = await quoteTransfer(requestPayload);
      setDraft((prev) => ({ ...prev, legacyQuote: nextQuote, stablecoinQuote: null }));
      setStep('review');
      if (nextQuote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(nextQuote) }));
      }
    } catch (error) {
      setDraft((prev) => ({ ...prev, legacyQuote: null }));
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (message === 'insufficient_fee_token_balance') {
        showError(t('wallet.transferInsufficientFeeTokenBalance'));
      } else if (message === 'unsupported_fee_token') {
        showError(t('wallet.transferUnsupportedFeeToken'));
      } else {
        showError(t('wallet.transferFailedRetry'));
      }
    } finally {
      setQuoting(false);
    }
  }

  async function quoteStablecoinTransfer(sourceNetworkKeyOverride?: string | null) {
    if (!stablecoinSymbol) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }

    const requestPayload = buildStablecoinSubmitPayload(
      {
        ...draft,
        selectedSourceNetworkKey: sourceNetworkKeyOverride ?? draft.selectedSourceNetworkKey,
      },
      stablecoinSymbol,
    );

    setQuoting(true);
    try {
      const nextQuote = await quoteCrossChainTransfer(requestPayload);
      setDraft((prev) => ({
        ...prev,
        selectedSourceNetworkKey: sourceNetworkKeyOverride ?? prev.selectedSourceNetworkKey,
        stablecoinQuote: nextQuote,
        legacyQuote: null,
      }));
      setStep('review');
    } catch {
      setDraft((prev) => ({ ...prev, stablecoinQuote: null }));
      showError(t('wallet.transferFailedRetry'));
    } finally {
      setQuoting(false);
    }
  }

  function handleRecipientNext() {
    const normalizedAddress = draft.recipient.trim();
    if (!normalizedAddress) {
      showError(t('wallet.transferAddressRequired'));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      recipient: normalizedAddress,
      legacyQuote: null,
      stablecoinQuote: null,
    }));
    setStep('network');
  }

  function handleAssetNext() {
    if (!selectedAssetOption) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }

    const nextSelectedAsset =
      selectedAssetOption.variants.find((asset) => asset.networkKey === draft.legacyNetworkKey)
      ?? selectedAssetOption.variants[0]
      ?? null;
    const nextStablecoinSymbol = getStablecoinSymbol(selectedAssetOption.symbol);
    const nextDestinationNetworkKey =
      nextStablecoinSymbol && stablecoinDestinationChains.some((chain) => chain.networkKey === draft.destinationNetworkKey)
        ? draft.destinationNetworkKey
        : nextStablecoinSymbol && nextSelectedAsset && STABLECOIN_DESTINATION_NETWORK_KEYS.has(nextSelectedAsset.networkKey)
          ? nextSelectedAsset.networkKey
          : stablecoinDestinationChains[0]?.networkKey ?? draft.destinationNetworkKey;

    setDraft((prev) => ({
      ...prev,
      selectedAssetOptionKey: selectedAssetOption.key,
      selectedAsset: nextSelectedAsset,
      legacyNetworkKey: nextSelectedAsset?.networkKey ?? prev.legacyNetworkKey,
      destinationNetworkKey: nextDestinationNetworkKey,
      selectedSourceNetworkKey: null,
      legacyQuote: null,
      stablecoinQuote: null,
    }));
    setStep('recipient');
  }

  function handleNetworkNext() {
    if (isStablecoinFlow) {
      if (!selectedDestinationChain) {
        showError(t('wallet.transferSelectDestinationNetwork'));
        return;
      }
      setStep('amount');
      return;
    }

    if (!selectedAsset) {
      showError(t('wallet.transferSelectNetwork'));
      return;
    }
    setStep('amount');
  }

  async function handleAmountNext() {
    const normalizedAmount = draft.amount.trim();
    const numericAmount = Number(normalizedAmount);
    if (!normalizedAmount || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      showError(t('wallet.transferAmountRequired'));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      amount: normalizedAmount,
      legacyQuote: null,
      stablecoinQuote: null,
    }));
    if (isStablecoinFlow) {
      await quoteStablecoinTransfer();
      return;
    }
    await quoteLegacyTransfer();
  }

  async function handleStablecoinSourceSelection(nextNetworkKey: string | null) {
    setDraft((prev) => ({
      ...prev,
      selectedSourceNetworkKey: nextNetworkKey,
    }));
    await quoteStablecoinTransfer(nextNetworkKey);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setStep('waiting');
    try {
      if (isStablecoinFlow) {
        if (!stablecoinSymbol || !draft.stablecoinQuote) {
          throw new Error('invalid_stablecoin_quote');
        }
        if (!draft.stablecoinQuote.canSubmit) {
          showError(
            draft.stablecoinQuote.executionMode === 'multi_source_bridge'
              ? t('wallet.transferStablecoinMultiSourceNotSupported')
              : t('wallet.transferStablecoinInsufficientBalance', {
                  amount:
                    formatTokenAmount(draft.stablecoinQuote.shortfallAmountRaw, draft.stablecoinQuote.destinationTokenDecimals)
                    ?? draft.stablecoinQuote.shortfallAmountRaw,
                  symbol: draft.stablecoinQuote.destinationTokenSymbol,
                }),
          );
          setStep('review');
          return;
        }

        const result = await submitCrossChainTransfer(buildStablecoinSubmitPayload(draft, stablecoinSymbol));
        if (result.status === 'failed') {
          throw new Error('crosschain_submit_failed');
        }
        onCompleted();
        showSuccess(t('wallet.transferSuccess'));
        setResultState({ success: true, mode: 'stable', result });
        setStep('result');
        return;
      }

      if (!draft.legacyQuote || !selectedAsset) {
        throw new Error('invalid_legacy_quote');
      }
      if (draft.legacyQuote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(draft.legacyQuote) }));
        setStep('review');
        return;
      }

      const result = await submitTransfer({
        networkKey: draft.legacyQuote.networkKey,
        toAddress: draft.legacyQuote.toAddress,
        amount: draft.legacyQuote.amountInput,
        tokenAddress: draft.legacyQuote.tokenAddress ?? undefined,
        tokenSymbol: draft.legacyQuote.tokenSymbol ?? undefined,
        tokenDecimals: draft.legacyQuote.tokenDecimals,
      });

      onCompleted();
      showSuccess(t('wallet.transferSuccess'));
      setResultState({ success: true, mode: 'legacy', transfer: result.transfer });
      setStep('result');
    } catch {
      const errorMessage = t('wallet.transferFailedRetry');
      showError(errorMessage);
      setResultState({ success: false, errorMessage });
      setStep('result');
    } finally {
      setSubmitting(false);
    }
  }

  function moveToPreviousStep() {
    if (step === 'result') {
      if (resultState?.success) {
        onClose();
        return;
      }
      setStep('review');
      return;
    }
    if (step === 'waiting') return;

    const currentIndex = stepSequence.indexOf(step);
    if (currentIndex <= 0) {
      onBack();
      return;
    }
    setStep(stepSequence[currentIndex - 1] ?? stepSequence[0] ?? 'asset');
  }

  function getStepTitle(): string {
    if (step === 'asset') return t('wallet.transferSelectAsset');
    if (step === 'recipient') return t('wallet.transferToAddress');
    if (step === 'network') return isStablecoinFlow ? t('wallet.transferSelectDestinationNetwork') : t('wallet.transferSelectNetwork');
    if (step === 'amount') return t('wallet.transferAmount');
    if (step === 'review') return t('wallet.transferReviewTransfer');
    if (step === 'waiting') return t('wallet.transferSubmitting');
    return resultState?.success ? t('wallet.transferSuccess') : t('wallet.transferFailed');
  }

  function renderRecipientStep() {
    const addressPlaceholder = isStablecoinFlow
      ? '0x...'
      : selectedLegacyChain?.symbol === 'BTC'
        ? 'bc1...'
        : selectedLegacyChain?.symbol === 'TRX'
          ? 'T...'
          : '0x...';

    return (
      <div className="mt-8 flex flex-col gap-4">
        {selectedAssetOption ? (
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.transferAsset')}</p>
            <p className="m-0 mt-1 font-semibold">
              {selectedAssetOption.symbol}
              {isStablecoinFlow ? '' : selectedLegacyChain ? ` · ${selectedLegacyChain.name}` : ''}
            </p>
          </div>
        ) : null}

        <label className="flex flex-col gap-2">
          <span className="text-sm text-base-content/70">{t('wallet.transferToAddress')}</span>
          <input
            className="input input-bordered w-full"
            placeholder={addressPlaceholder}
            value={draft.recipient}
            onChange={(event) => {
              setDraft((prev) => ({
                ...prev,
                recipient: event.target.value,
                legacyQuote: null,
                stablecoinQuote: null,
              }));
            }}
            disabled={submitting || quoting}
          />
        </label>

        <button type="button" className="btn btn-primary mt-2" disabled={submitting || quoting} onClick={handleRecipientNext}>
          {t('wallet.transferNext')}
        </button>
      </div>
    );
  }

  function renderAssetStep() {
    return (
      <div className="mt-8 flex flex-col gap-3">
        {assetOptions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
            {t('wallet.transferNoAssetsForNetwork')}
          </div>
        ) : (
          assetOptions.map((option) => {
            const isActive = selectedAssetOption?.key === option.key;
            const chainSummary = option.variants.length > 1
              ? t('wallet.multiChainCount', { count: option.variants.length })
              : t('wallet.singleChainLabel', {
                  chain: selectableChains.find((chain) => chain.networkKey === option.variants[0]?.networkKey)?.name ?? option.variants[0]?.networkKey ?? '--',
                });
            const isStablecoin = Boolean(getStablecoinSymbol(option.symbol));
            return (
              <button
                key={option.key}
                type="button"
                className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                  isActive ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
                }`}
                onClick={() => {
                  const nextSelectedAsset = option.variants.find((asset) => asset.networkKey === draft.legacyNetworkKey) ?? option.variants[0] ?? null;
                  setDraft((prev) => ({
                    ...prev,
                    selectedAssetOptionKey: option.key,
                    selectedAsset: nextSelectedAsset,
                    legacyNetworkKey: nextSelectedAsset?.networkKey ?? prev.legacyNetworkKey,
                    selectedSourceNetworkKey: null,
                    legacyQuote: null,
                    stablecoinQuote: null,
                  }));
                }}
                disabled={submitting || quoting}
              >
                <div className="flex items-center gap-3">
                  <AssetAvatar src={option.logo} label={option.symbol || option.name} alt={option.symbol || option.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="m-0 truncate font-semibold text-base-content">{option.symbol}</p>
                      {isActive ? <CheckCircle2 size={18} className="shrink-0 text-primary" /> : null}
                    </div>
                    <p className="m-0 truncate text-sm text-base-content/60">{option.name}</p>
                    <p className="m-0 mt-1 text-sm text-base-content/60">
                      {t('wallet.transferAssetBalance')}: {option.totalAmountText} {option.symbol}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-base-content/50">
                      <span>{chainSummary}</span>
                      {isStablecoin ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                          {t('wallet.transferStablecoinBadge')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}

        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={submitting || quoting || !selectedAssetOption}
          onClick={handleAssetNext}
        >
          {t('wallet.transferNext')}
        </button>
      </div>
    );
  }

  function renderLegacyNetworkStep() {
    return (
      <div className="mt-8 flex flex-col gap-3">
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
          <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferAsset')}</p>
          <p className="m-0 mt-1 font-semibold">{selectedAssetOption?.symbol ?? t('wallet.transferAssetUnavailable')}</p>
        </div>

        {networkOptions.map((asset) => {
          const chain = selectableChains.find((item) => item.networkKey === asset.networkKey) ?? selectedLegacyChain;
          const isActive = selectedAsset?.key === asset.key;
          return (
            <button
              key={asset.key}
              type="button"
              className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                isActive ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
              }`}
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  legacyNetworkKey: asset.networkKey,
                  selectedAsset: asset,
                  legacyQuote: null,
                  stablecoinQuote: null,
                }));
              }}
              disabled={submitting || quoting}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="m-0 font-semibold text-base-content">{chain?.name ?? asset.networkKey}</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">
                    {t('wallet.transferAssetBalance')}: {asset.amountText} {asset.symbol}
                  </p>
                </div>
                {isActive ? <CheckCircle2 size={18} className="text-primary" /> : null}
              </div>
            </button>
          );
        })}

        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={submitting || quoting || !selectedAsset}
          onClick={handleNetworkNext}
        >
          {t('wallet.transferNext')}
        </button>
      </div>
    );
  }

  function renderStablecoinNetworkStep() {
    return (
      <div className="mt-8 flex flex-col gap-3">
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
          <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferAsset')}</p>
          <p className="m-0 mt-1 font-semibold">{stablecoinSymbol ?? t('wallet.transferAssetUnavailable')}</p>
          {selectedAssetOption ? (
            <p className="m-0 mt-1 text-base-content/60">
              {t('wallet.transferAssetBalance')}: {selectedAssetOption.totalAmountText} {selectedAssetOption.symbol}
            </p>
          ) : null}
        </div>

        {stablecoinDestinationChains.map((chain) => {
          const matchingVariant = selectedAssetOption?.variants.find((asset) => asset.networkKey === chain.networkKey) ?? null;
          const isActive = draft.destinationNetworkKey === chain.networkKey;
          return (
            <button
              key={chain.networkKey}
              type="button"
              className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                isActive ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
              }`}
              onClick={() => {
                setDraft((prev) => ({
                  ...prev,
                  destinationNetworkKey: chain.networkKey,
                  selectedSourceNetworkKey: null,
                  stablecoinQuote: null,
                }));
              }}
              disabled={submitting || quoting}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="m-0 font-semibold text-base-content">{chain.name}</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">
                    {t('wallet.transferStablecoinDestinationHint', { symbol: stablecoinSymbol ?? '--' })}
                  </p>
                  {matchingVariant ? (
                    <p className="m-0 mt-1 text-xs text-base-content/50">
                      {t('wallet.transferStablecoinLocalBalance', {
                        amount: matchingVariant.amountText,
                        symbol: matchingVariant.symbol,
                      })}
                    </p>
                  ) : null}
                </div>
                {isActive ? <CheckCircle2 size={18} className="text-primary" /> : null}
              </div>
            </button>
          );
        })}

        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={submitting || quoting || !selectedDestinationChain}
          onClick={handleNetworkNext}
        >
          {t('wallet.transferNext')}
        </button>
      </div>
    );
  }

  function renderNetworkStep() {
    return isStablecoinFlow ? renderStablecoinNetworkStep() : renderLegacyNetworkStep();
  }

  function renderAmountStep() {
    return (
      <div className="mt-8 flex flex-col gap-4">
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
          <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferAsset')}</p>
          <p className="m-0 mt-1 font-semibold">
            {isStablecoinFlow ? stablecoinSymbol : selectedAsset?.symbol ?? t('wallet.transferAssetUnavailable')}
            {selectedChainLabel ? ` · ${selectedChainLabel}` : ''}
          </p>
          {isStablecoinFlow ? (
            selectedAssetOption ? (
              <p className="m-0 mt-1 text-base-content/60">
                {t('wallet.transferAssetBalance')}: {selectedAssetOption.totalAmountText} {selectedAssetOption.symbol}
              </p>
            ) : null
          ) : selectedAsset ? (
            <p className="m-0 mt-1 text-base-content/60">
              {t('wallet.transferAssetBalance')}: {selectedAsset.amountText} {selectedAsset.symbol}
            </p>
          ) : null}
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm text-base-content/70">{isStablecoinFlow ? t('wallet.transferStablecoinReceiveAmount') : t('wallet.transferAmount')}</span>
          <input
            className="input input-bordered w-full"
            placeholder="0.0"
            value={draft.amount}
            inputMode="decimal"
            onChange={(event) => {
              setDraft((prev) => ({
                ...prev,
                amount: event.target.value,
                legacyQuote: null,
                stablecoinQuote: null,
              }));
            }}
            disabled={submitting || quoting}
          />
        </label>

        <button type="button" className="btn btn-primary mt-2" disabled={submitting || quoting} onClick={() => void handleAmountNext()}>
          {quoting ? <LoaderCircle size={16} className="animate-spin" /> : null}
          {t('wallet.transferReviewTransfer')}
        </button>
      </div>
    );
  }

  function renderLegacyReviewStep() {
    return (
      <div className="mt-8 flex flex-col gap-4">
        {draft.legacyQuote ? (
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.transferQuoteFee')}</p>
            <p className="m-0 mt-1 break-all font-semibold">{getDisplayFeeText(draft.legacyQuote)}</p>
            {draft.legacyQuote.insufficientFeeTokenBalance ? (
              <p className="m-0 mt-2 text-warning">
                {t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(draft.legacyQuote) })}
              </p>
            ) : null}
            <p className="m-0 mt-2 text-base-content/60">
              {t('wallet.transferToAddress')}: {truncateAddress(draft.legacyQuote.toAddress)}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferAsset')}: {selectedAsset?.symbol ?? draft.legacyQuote.tokenSymbol ?? t('wallet.transferAssetUnavailable')}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferChain')}: {selectedLegacyChain?.name ?? draft.legacyQuote.networkKey}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferAmount')}: {draft.legacyQuote.amountInput}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
            {t('wallet.transferQuoteUnavailable')}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={submitting || quoting || Boolean(draft.legacyQuote?.insufficientFeeTokenBalance)}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {submitting ? <LoaderCircle size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
          {t('wallet.transferConfirm')}
        </button>
      </div>
    );
  }

  function renderStablecoinSourceSelector(quote: CrossChainTransferQuoteResponse) {
    if (quote.availableSourceOptions.length <= 1) return null;

    return (
      <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 text-left"
          onClick={() => setSourcePickerExpanded((prev) => !prev)}
          disabled={quoting || submitting}
        >
          <div>
            <p className="m-0 text-base-content/70">{t('wallet.transferStablecoinSourceOverride')}</p>
            <p className="m-0 mt-1 font-semibold">
              {draft.selectedSourceNetworkKey
                ? getNetworkName(draft.selectedSourceNetworkKey)
                : t('wallet.transferStablecoinAutoSource', {
                    chain: getNetworkName(quote.recommendedSourceNetworkKey ?? quote.selectedSourceNetworkKey),
                  })}
            </p>
          </div>
          <ChevronDown size={18} className={`transition-transform ${sourcePickerExpanded ? 'rotate-180' : ''}`} />
        </button>

        {sourcePickerExpanded ? (
          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              className={`rounded-xl border px-3 py-3 text-left transition ${
                draft.selectedSourceNetworkKey === null ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
              }`}
              onClick={() => void handleStablecoinSourceSelection(null)}
              disabled={quoting || submitting}
            >
              <p className="m-0 font-semibold text-base-content">
                {t('wallet.transferStablecoinAutoSource', {
                  chain: getNetworkName(quote.recommendedSourceNetworkKey ?? quote.selectedSourceNetworkKey),
                })}
              </p>
              <p className="m-0 mt-1 text-xs text-base-content/60">{t('wallet.transferStablecoinAutoSourceHint')}</p>
            </button>

            {quote.availableSourceOptions.map((option) => {
              const isActive = draft.selectedSourceNetworkKey === option.networkKey;
              const availableText = formatTokenAmount(option.availableAmountRaw, option.tokenDecimals) ?? option.availableAmountRaw;
              return (
                <button
                  key={option.networkKey}
                  type="button"
                  className={`rounded-xl border px-3 py-3 text-left transition ${
                    isActive ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
                  }`}
                  onClick={() => void handleStablecoinSourceSelection(option.networkKey)}
                  disabled={quoting || submitting}
                >
                  <p className="m-0 font-semibold text-base-content">{getNetworkName(option.networkKey)}</p>
                  <p className="m-0 mt-1 text-xs text-base-content/60">
                    {t('wallet.transferStablecoinSourceBalance', {
                      amount: availableText,
                      symbol: option.tokenSymbol,
                    })}
                  </p>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderStablecoinReviewStep() {
    const quote = draft.stablecoinQuote;
    const firstLeg = quote?.legs[0] ?? null;
    const receiveText = quote
      ? formatTokenAmount(quote.estimatedReceivedAmountRaw, quote.destinationTokenDecimals) ?? quote.requestedAmountInput
      : null;
    const shortfallText = quote
      ? formatTokenAmount(quote.shortfallAmountRaw, quote.destinationTokenDecimals) ?? quote.shortfallAmountRaw
      : null;
    const sourceNetworkLabel = getNetworkName(quote?.selectedSourceNetworkKey ?? quote?.recommendedSourceNetworkKey ?? null);
    const etaText = formatDuration(firstLeg?.estimatedDurationSeconds ?? null);

    return (
      <div className="mt-8 flex flex-col gap-4">
        {quote ? (
          <>
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
              <p className="m-0 text-base-content/70">{t('wallet.transferStablecoinRecipientReceives')}</p>
              <p className="m-0 mt-1 font-semibold">
                {receiveText ?? quote.requestedAmountInput} {quote.destinationTokenSymbol} · {getNetworkName(quote.destinationNetworkKey)}
              </p>
              <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferStablecoinDebitedFrom')}</p>
              <p className="m-0 mt-1 font-semibold">{sourceNetworkLabel}</p>
              <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferStablecoinRoute')}</p>
              <p className="m-0 mt-1 font-semibold">{firstLeg?.tool ?? (quote.executionMode === 'direct' ? t('wallet.transferStablecoinRouteDirect') : t('wallet.transferQuoteUnavailable'))}</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="m-0 text-base-content/70">{t('wallet.transferStablecoinEta')}</p>
                  <p className="m-0 mt-1 font-semibold">{etaText ?? t('wallet.transferQuoteUnavailable')}</p>
                </div>
                <div>
                  <p className="m-0 text-base-content/70">{t('wallet.transferQuoteFee')}</p>
                  <p className="m-0 mt-1 font-semibold">{getStablecoinFeeText(quote)}</p>
                </div>
              </div>
            </div>

            {renderStablecoinSourceSelector(quote)}

            {quote.executionMode === 'multi_source_bridge' ? (
              <div className="rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-warning-content">
                {t('wallet.transferStablecoinMultiSourceNotSupported')}
              </div>
            ) : null}

            {quote.executionMode === 'insufficient_balance' ? (
              <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm text-error-content">
                {t('wallet.transferStablecoinInsufficientBalance', {
                  amount: shortfallText ?? quote.shortfallAmountRaw,
                  symbol: quote.destinationTokenSymbol,
                })}
              </div>
            ) : null}
          </>
        ) : (
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
            {t('wallet.transferQuoteUnavailable')}
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary mt-2"
          disabled={submitting || quoting || !quote?.canSubmit}
          onClick={() => {
            void handleSubmit();
          }}
        >
          {submitting ? <LoaderCircle size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
          {t('wallet.transferConfirm')}
        </button>
      </div>
    );
  }

  function renderReviewStep() {
    return isStablecoinFlow ? renderStablecoinReviewStep() : renderLegacyReviewStep();
  }

  function renderWaitingStep() {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <LoaderCircle size={56} className="animate-spin text-primary" />
        <p className="m-0 text-xl font-semibold">{t('wallet.transferSubmitting')}</p>
        <p className="m-0 text-sm text-base-content/70">{t('wallet.transferWaitingHint')}</p>
      </div>
    );
  }

  function renderResultStep() {
    const stableResult = resultState?.success && resultState.mode === 'stable' ? resultState.result : null;
    const legacyResult = resultState?.success && resultState.mode === 'legacy' ? resultState.transfer : null;
    const stableQuote = stableResult?.quote ?? draft.stablecoinQuote;
    const stableTxHash = stableResult?.legs[0]?.txHash ?? null;

    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        {resultState?.success ? (
          <CheckCircle2 size={56} className="text-success" />
        ) : (
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-error/15 text-error">
            <X size={30} />
          </span>
        )}
        <p className="m-0 text-xl font-semibold">{resultState?.success ? t('wallet.transferSuccess') : t('wallet.transferFailed')}</p>
        {resultState?.success ? (
          <div className="w-full rounded-2xl border border-base-300 bg-base-100 p-4 text-left text-sm">
            <p className="m-0 text-base-content/70">
              {t('wallet.transferToAddress')}: {truncateAddress(legacyResult?.toAddress ?? stableQuote?.toAddress ?? draft.recipient)}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferAsset')}:{' '}
              {legacyResult?.tokenSymbol
                ?? stableQuote?.destinationTokenSymbol
                ?? selectedAsset?.symbol
                ?? t('wallet.transferAssetUnavailable')}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferAmount')}:{' '}
              {legacyResult?.amountInput
                ?? (stableQuote
                  ? `${formatTokenAmount(stableQuote.estimatedReceivedAmountRaw, stableQuote.destinationTokenDecimals) ?? stableQuote.requestedAmountInput} ${stableQuote.destinationTokenSymbol}`
                  : draft.amount)}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferChain')}: {stableQuote ? getNetworkName(stableQuote.destinationNetworkKey) : selectedChainLabel}
            </p>
            {legacyResult?.txHash || stableTxHash ? (
              <p className="m-0 mt-1 break-all text-base-content/70">Tx: {legacyResult?.txHash ?? stableTxHash}</p>
            ) : null}
          </div>
        ) : (
          <p className="m-0 text-sm text-base-content/70">{resultState?.errorMessage}</p>
        )}
        <div className="mt-2 grid w-full grid-cols-2 gap-3">
          <button
            type="button"
            className="btn btn-outline"
            onClick={handleButtonClick(() => {
              if (resultState?.success) {
                onClose();
                return;
              }
              setStep('review');
            })}
          >
            {resultState?.success ? t('wallet.transferDone') : t('wallet.transferRetry')}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleButtonClick(onClose)}>
            {t('common.close')}
          </button>
        </div>
      </div>
    );
  }

  function renderStepContent() {
    if (step === 'asset') return renderAssetStep();
    if (step === 'recipient') return renderRecipientStep();
    if (step === 'network') return renderNetworkStep();
    if (step === 'amount') return renderAmountStep();
    if (step === 'review') return renderReviewStep();
    if (step === 'waiting') return renderWaitingStep();
    return renderResultStep();
  }

  return (
    <ModalContentScaffold
      title={t('wallet.transferTitle')}
      headerMeta={(
        <>
          <p className="m-0 text-sm text-base-content/70">{getStepTitle()}</p>
          <progress className="progress progress-primary mt-3 w-full" value={stepIndex} max={stepSequence.length} />
        </>
      )}
      bodyClassName="justify-start pt-8"
      stageClassName={stageClassName}
      showBack
      onBack={handleButtonClick(moveToPreviousStep)}
      backAriaLabel={t('wallet.back')}
      onClose={handleButtonClick(onClose)}
      closeAriaLabel={t('common.close')}
      hideFooter={step === 'waiting' || step === 'result'}
      footerVisible={footerVisible}
    >
      {renderStepContent()}
    </ModalContentScaffold>
  );
}
