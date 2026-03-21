import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { quoteTransfer, submitTransfer, type TransferQuoteResponse, type TransferRecord } from '../../api';
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
  onSubmitted: (transfer: TransferRecord) => void;
  footerVisible?: boolean;
  stageClassName?: string;
};

type TransferStep = 'recipient' | 'asset' | 'network' | 'amount' | 'review' | 'waiting' | 'result';

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
  networkKey: string;
  selectedAssetOptionKey: string | null;
  selectedAsset: TransferSelectableAsset | null;
  amount: string;
  quote: TransferQuoteResponse | null;
};

type TransferResultState =
  | {
      success: boolean;
      transfer?: TransferRecord;
      errorMessage?: string;
    }
  | null;

const ASSET_STEP_FALLBACK_LABEL = 'T';

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
  onSubmitted,
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
    () => (entryPoint === 'wallet' ? ['recipient', 'asset', 'network', 'amount', 'review'] : ['recipient', 'amount', 'review']),
    [entryPoint],
  );
  const initialNetworkKey = lockedAsset?.networkKey ?? selectableChains[0]?.networkKey ?? supportedChains[0]?.networkKey ?? 'ethereum-mainnet';
  const [draft, setDraft] = useState<TransferDraft>({
    recipient: '',
    networkKey: initialNetworkKey,
    selectedAssetOptionKey: lockedAsset ? getTransferAssetOptionKey(lockedAsset) : null,
    selectedAsset: lockedAsset,
    amount: '',
    quote: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [step, setStep] = useState<TransferStep>(stepSequence[0] ?? 'recipient');
  const [resultState, setResultState] = useState<TransferResultState>(null);

  const selectedChain = useMemo(
    () => supportedChains.find((item) => item.networkKey === draft.networkKey) ?? supportedChains[0] ?? null,
    [draft.networkKey, supportedChains],
  );
  const selectedAssetOption = useMemo(
    () => assetOptions.find((option) => option.key === draft.selectedAssetOptionKey) ?? null,
    [assetOptions, draft.selectedAssetOptionKey],
  );
  const networkOptions = useMemo(
    () => (selectedAssetOption?.variants ?? []).filter((asset) => selectableChains.some((chain) => chain.networkKey === asset.networkKey)),
    [selectableChains, selectedAssetOption?.variants],
  );
  const selectedAsset = lockedAsset ?? draft.selectedAsset;
  const stepIndex = useMemo(() => {
    const interactiveIndex = stepSequence.indexOf(step);
    if (interactiveIndex >= 0) return interactiveIndex + 1;
    return stepSequence.length;
  }, [step, stepSequence]);

  useEffect(() => {
    if (!active) return;
    setDraft({
      recipient: '',
      networkKey: initialNetworkKey,
      selectedAssetOptionKey: lockedAsset ? getTransferAssetOptionKey(lockedAsset) : null,
      selectedAsset: lockedAsset,
      amount: '',
      quote: null,
    });
    setSubmitting(false);
    setQuoting(false);
    setStep(stepSequence[0] ?? 'recipient');
    setResultState(null);
  }, [active, initialNetworkKey, lockedAsset, stepSequence]);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  function getDisplayFeeText(nextQuote: TransferQuoteResponse): string {
    const fallbackSymbol = selectedAsset?.symbol ?? selectedChain?.symbol ?? nextQuote.tokenSymbol ?? '';
    const symbol = nextQuote.estimatedFeeTokenAddress ? (nextQuote.tokenSymbol ?? fallbackSymbol) : fallbackSymbol;
    if (nextQuote.estimatedFeeTokenAmount) {
      return `${nextQuote.estimatedFeeTokenAmount} ${symbol}`.trim();
    }
    const normalized = formatTokenAmount(nextQuote.estimatedFeeTokenWei, nextQuote.tokenDecimals);
    if (normalized) return `${normalized} ${symbol}`.trim();
    return nextQuote.estimatedFeeWei ?? t('wallet.transferQuoteUnavailable');
  }

  async function handleQuote() {
    if (!selectedAsset) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }

    const requestPayload = {
      networkKey: draft.networkKey,
      toAddress: draft.recipient.trim(),
      amount: draft.amount.trim(),
      tokenAddress: selectedAsset.isNative ? undefined : selectedAsset.tokenAddress,
      tokenSymbol: selectedAsset.symbol,
      tokenDecimals: selectedAsset.tokenDecimals,
    };
    console.log('[wallet-ui][transfer/quote] request', requestPayload);

    setQuoting(true);
    try {
      const nextQuote = await quoteTransfer(requestPayload);
      setDraft((prev) => ({ ...prev, quote: nextQuote }));
      setStep('review');
      if (nextQuote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(nextQuote) }));
      }
    } catch (error) {
      setDraft((prev) => ({ ...prev, quote: null }));
      const message = error instanceof Error ? error.message : 'unknown_error';
      if (message === 'insufficient_fee_token_balance') {
        showError(t('wallet.transferInsufficientFeeTokenBalance'));
      } else if (message === 'unsupported_fee_token') {
        showError(t('wallet.transferUnsupportedFeeToken'));
      } else {
        showError(`${t('wallet.transferFailed')}: ${message}`);
      }
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
    setDraft((prev) => ({ ...prev, recipient: normalizedAddress }));
    setStep(entryPoint === 'wallet' ? 'asset' : 'amount');
  }

  function handleAssetNext() {
    if (!selectedAssetOption) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }
    const nextSelectedAsset = selectedAssetOption.variants.find((asset) => asset.networkKey === draft.networkKey) ?? selectedAssetOption.variants[0] ?? null;
    if (!nextSelectedAsset) {
      showError(t('wallet.transferNoAssetsForNetwork'));
      return;
    }
    setDraft((prev) => ({
      ...prev,
      networkKey: nextSelectedAsset.networkKey,
      selectedAsset: nextSelectedAsset,
      quote: null,
    }));
    setStep('network');
  }

  function handleNetworkNext() {
    if (!selectedAsset) {
      showError(t('wallet.transferSelectNetwork'));
      return;
    }
    setStep('amount');
  }

  async function handleAmountNext() {
    if (!selectedAsset) {
      showError(t('wallet.transferAssetRequired'));
      return;
    }
    const normalizedAmount = draft.amount.trim();
    const numericAmount = Number(normalizedAmount);
    if (!normalizedAmount || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      showError(t('wallet.transferAmountRequired'));
      return;
    }
    setDraft((prev) => ({ ...prev, amount: normalizedAmount }));
    await handleQuote();
  }

  async function handleSubmit() {
    if (!draft.quote || !selectedAsset) return;

    setSubmitting(true);
    setStep('waiting');
    try {
      if (draft.quote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(draft.quote) }));
        setStep('review');
        return;
      }

      const result = await submitTransfer({
        networkKey: draft.quote.networkKey,
        toAddress: draft.quote.toAddress,
        amount: draft.quote.amountInput,
        tokenAddress: draft.quote.tokenAddress ?? undefined,
        tokenSymbol: draft.quote.tokenSymbol ?? undefined,
        tokenDecimals: draft.quote.tokenDecimals,
      });

      onSubmitted(result.transfer);
      showSuccess(t('wallet.transferSuccess'));
      setResultState({ success: true, transfer: result.transfer });
      setStep('result');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'unknown_error';
      showError(`${t('wallet.transferFailed')}: ${errorMessage}`);
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
    setStep(stepSequence[currentIndex - 1] ?? stepSequence[0] ?? 'recipient');
  }

  function getStepTitle(): string {
    if (step === 'recipient') return t('wallet.transferToAddress');
    if (step === 'asset') return t('wallet.transferSelectAsset');
    if (step === 'network') return t('wallet.transferSelectNetwork');
    if (step === 'amount') return t('wallet.transferAmount');
    if (step === 'review') return t('wallet.transferReviewFee');
    if (step === 'waiting') return t('wallet.transferSubmitting');
    return resultState?.success ? t('wallet.transferSuccess') : t('wallet.transferFailed');
  }

  function renderRecipientStep() {
    const addressPlaceholder = selectedChain?.symbol === 'BTC' ? 'bc1...' : selectedChain?.symbol === 'TRX' ? 'T...' : '0x...';
    return (
      <div className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-base-content/70">{t('wallet.transferToAddress')}</span>
          <input
            className="input input-bordered w-full"
            placeholder={addressPlaceholder}
            value={draft.recipient}
            onChange={(event) => {
              setDraft((prev) => ({ ...prev, recipient: event.target.value, quote: null }));
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
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
        </div>

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
            return (
              <button
                key={option.key}
                type="button"
                className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                  isActive ? 'border-primary bg-primary/8' : 'border-base-300 bg-base-100 hover:bg-base-200/60'
                }`}
                onClick={() => {
                  const nextSelectedAsset = option.variants.find((asset) => asset.networkKey === draft.networkKey) ?? option.variants[0] ?? null;
                  setDraft((prev) => ({
                    ...prev,
                    selectedAssetOptionKey: option.key,
                    networkKey: nextSelectedAsset?.networkKey ?? prev.networkKey,
                    selectedAsset: nextSelectedAsset,
                    quote: null,
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
                    <p className="m-0 mt-1 text-xs text-base-content/50">{chainSummary}</p>
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

  function renderNetworkStep() {
    return (
      <div className="mt-8 flex flex-col gap-3">
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
          <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferAsset')}</p>
          <p className="m-0 mt-1 font-semibold">{selectedAssetOption?.symbol ?? t('wallet.transferAssetUnavailable')}</p>
        </div>

        {networkOptions.map((asset) => {
          const chain = selectableChains.find((item) => item.networkKey === asset.networkKey) ?? selectedChain;
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
                  networkKey: asset.networkKey,
                  selectedAsset: asset,
                  quote: null,
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

  function renderAmountStep() {
    return (
      <div className="mt-8 flex flex-col gap-4">
        <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
          <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
          <p className="m-0 mt-1 break-all font-semibold">{draft.recipient}</p>
          <p className="m-0 mt-3 text-base-content/70">{t('wallet.transferAsset')}</p>
          <p className="m-0 mt-1 font-semibold">
            {selectedAsset?.symbol ?? t('wallet.transferAssetUnavailable')}
            {selectedChain ? ` · ${selectedChain.name}` : ''}
          </p>
          {selectedAsset ? (
            <p className="m-0 mt-1 text-base-content/60">
              {t('wallet.transferAssetBalance')}: {selectedAsset.amountText} {selectedAsset.symbol}
            </p>
          ) : null}
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm text-base-content/70">{t('wallet.transferAmount')}</span>
          <input
            className="input input-bordered w-full"
            placeholder="0.0"
            value={draft.amount}
            inputMode="decimal"
            onChange={(event) => {
              setDraft((prev) => ({ ...prev, amount: event.target.value, quote: null }));
            }}
            disabled={submitting || quoting}
          />
        </label>

        <button type="button" className="btn btn-primary mt-2" disabled={submitting || quoting} onClick={() => void handleAmountNext()}>
          {quoting ? <LoaderCircle size={16} className="animate-spin" /> : null}
          {t('wallet.transferReviewFee')}
        </button>
      </div>
    );
  }

  function renderReviewStep() {
    return (
      <div className="mt-8 flex flex-col gap-4">
        {draft.quote ? (
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.transferQuoteFee')}</p>
            <p className="m-0 mt-1 break-all font-semibold">{getDisplayFeeText(draft.quote)}</p>
            {draft.quote.insufficientFeeTokenBalance ? (
              <p className="m-0 mt-2 text-warning">
                {t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(draft.quote) })}
              </p>
            ) : null}
            <p className="m-0 mt-2 text-base-content/60">
              {t('wallet.transferToAddress')}: {truncateAddress(draft.quote.toAddress)}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferAsset')}: {selectedAsset?.symbol ?? draft.quote.tokenSymbol ?? t('wallet.transferAssetUnavailable')}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferChain')}: {selectedChain?.name ?? draft.quote.networkKey}
            </p>
            <p className="m-0 text-base-content/60">
              {t('wallet.transferAmount')}: {draft.quote.amountInput}
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
          disabled={submitting || quoting || Boolean(draft.quote?.insufficientFeeTokenBalance)}
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
              {t('wallet.transferToAddress')}: {truncateAddress(resultState.transfer?.toAddress ?? draft.recipient)}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferAsset')}: {selectedAsset?.symbol ?? resultState.transfer?.tokenSymbol ?? t('wallet.transferAssetUnavailable')}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferAmount')}: {resultState.transfer?.amountInput ?? draft.amount}
            </p>
            {resultState.transfer?.txHash ? (
              <p className="m-0 mt-1 break-all text-base-content/70">Tx: {resultState.transfer.txHash}</p>
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
    if (step === 'recipient') return renderRecipientStep();
    if (step === 'asset') return renderAssetStep();
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
