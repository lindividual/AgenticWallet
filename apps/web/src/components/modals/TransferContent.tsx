import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ArrowLeft, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { quoteTransfer, submitTransfer, type TransferQuoteResponse, type TransferRecord } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { ModalContentScaffold } from './ModalContentScaffold';

type TransferContentProps = {
  active: boolean;
  presetAsset?: {
    networkKey: string;
    tokenAddress?: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
  } | null;
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

type TransferStep = 'address' | 'amount' | 'review' | 'waiting' | 'result';
type TransferResultState =
  | {
      success: boolean;
      transfer?: TransferRecord;
      errorMessage?: string;
    }
  | null;

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTokenAmount(rawAmount: string | null, decimals: number | null | undefined): string | null {
  if (!rawAmount) return null;
  const normalizedDecimals = Number.isFinite(decimals) ? Number(decimals) : 18;
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

export function TransferContent({
  active,
  presetAsset = null,
  supportedChains,
  onClose,
  onBack,
  onSubmitted,
  footerVisible = true,
  stageClassName,
}: TransferContentProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [networkKey, setNetworkKey] = useState<string>(supportedChains[0]?.networkKey ?? 'ethereum-mainnet');
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<TransferQuoteResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [step, setStep] = useState<TransferStep>('address');
  const [resultState, setResultState] = useState<TransferResultState>(null);
  const isTokenTransfer = Boolean(presetAsset?.tokenAddress);
  const chainLocked = Boolean(presetAsset);

  useEffect(() => {
    if (!active) return;
    setNetworkKey(presetAsset?.networkKey ?? supportedChains[0]?.networkKey ?? 'ethereum-mainnet');
    setToAddress('');
    setAmount('');
    setQuote(null);
    setSubmitting(false);
    setQuoting(false);
    setStep('address');
    setResultState(null);
  }, [active, supportedChains, presetAsset]);

  const selectedChain = useMemo(
    () => supportedChains.find((item) => item.networkKey === networkKey) ?? supportedChains[0] ?? null,
    [networkKey, supportedChains],
  );
  const stepIndex = useMemo(() => {
    const mapping: Record<TransferStep, number> = {
      address: 1,
      amount: 2,
      review: 3,
      waiting: 4,
      result: 5,
    };
    return mapping[step];
  }, [step]);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  function getDisplayFeeText(nextQuote: TransferQuoteResponse): string {
    const symbol = nextQuote.tokenSymbol ?? '';
    if (nextQuote.estimatedFeeTokenAmount) {
      return `${nextQuote.estimatedFeeTokenAmount} ${symbol}`.trim();
    }
    const normalized = formatTokenAmount(nextQuote.estimatedFeeTokenWei, nextQuote.tokenDecimals);
    if (normalized) return `${normalized} ${symbol}`.trim();
    return nextQuote.estimatedFeeWei ?? t('wallet.transferQuoteUnavailable');
  }

  async function handleQuote() {
    const normalizedAddress = toAddress.trim();
    const normalizedAmount = amount.trim();
    const requestPayload = {
      networkKey,
      toAddress: normalizedAddress,
      amount: normalizedAmount,
      tokenAddress: presetAsset?.tokenAddress,
      tokenSymbol: presetAsset?.tokenSymbol,
      tokenDecimals: presetAsset?.tokenDecimals,
    };
    console.log('[wallet-ui][transfer/quote] request', requestPayload);

    setQuoting(true);
    try {
      const nextQuote = await quoteTransfer(requestPayload);
      setQuote(nextQuote);
      setStep('review');
      console.log('[wallet-ui][transfer/quote] success', {
        networkKey: nextQuote.networkKey,
        toAddress: nextQuote.toAddress,
        tokenAddress: nextQuote.tokenAddress,
        tokenSymbol: nextQuote.tokenSymbol,
        tokenDecimals: nextQuote.tokenDecimals,
        amountInput: nextQuote.amountInput,
        amountRaw: nextQuote.amountRaw,
        estimatedFeeWei: nextQuote.estimatedFeeWei,
      });
      if (nextQuote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(nextQuote) }));
      }
    } catch (error) {
      setQuote(null);
      console.error('[wallet-ui][transfer/quote] failed', {
        request: requestPayload,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      const message = (error as Error).message;
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

  async function handleAddressNext() {
    const normalizedAddress = toAddress.trim();
    if (!normalizedAddress) {
      showError(t('wallet.transferAddressRequired'));
      return;
    }
    setToAddress(normalizedAddress);
    setStep('amount');
  }

  async function handleAmountNext() {
    const normalizedAmount = amount.trim();
    const numericAmount = Number(normalizedAmount);
    if (!normalizedAmount || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      showError(t('wallet.transferAmountRequired'));
      return;
    }
    setAmount(normalizedAmount);
    await handleQuote();
  }

  async function handleSubmit() {
    if (!quote) return;

    setSubmitting(true);
    setStep('waiting');
    try {
      if (quote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(quote) }));
        setStep('review');
        return;
      }

      const submitPayload = {
        networkKey: quote.networkKey,
        toAddress: quote.toAddress,
        amount: quote.amountInput,
        tokenAddress: quote.tokenAddress ?? undefined,
        tokenSymbol: quote.tokenSymbol ?? undefined,
        tokenDecimals: quote.tokenDecimals,
      };
      console.log('[wallet-ui][transfer/submit] request', submitPayload);

      const result = await submitTransfer(submitPayload);
      console.log('[wallet-ui][transfer/submit] success', {
        id: result.transfer.id,
        status: result.transfer.status,
        txHash: result.transfer.txHash,
        networkKey: result.transfer.networkKey,
      });

      onSubmitted(result.transfer);
      showSuccess(t('wallet.transferSuccess'));
      setResultState({ success: true, transfer: result.transfer });
      setStep('result');
    } catch (error) {
      console.error('[wallet-ui][transfer/submit] failed', {
        networkKey: quote.networkKey,
        toAddress: quote.toAddress,
        tokenAddress: quote.tokenAddress,
        tokenSymbol: quote.tokenSymbol,
        tokenDecimals: quote.tokenDecimals,
        amountInput: quote.amountInput,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      const errorMessage = error instanceof Error ? error.message : 'unknown_error';
      showError(`${t('wallet.transferFailed')}: ${errorMessage}`);
      setResultState({ success: false, errorMessage });
      setStep('result');
    } finally {
      setSubmitting(false);
    }
  }

  function handleFooterBack() {
    if (step === 'waiting') return;
    if (step === 'result') {
      if (resultState?.success) {
        onClose();
        return;
      }
      setStep('review');
      return;
    }
    if (step === 'review') {
      setStep('amount');
      return;
    }
    if (step === 'amount') {
      setStep('address');
      return;
    }
    onBack();
  }

  function handleResultPrimaryAction() {
    if (resultState?.success) {
      onClose();
      return;
    }
    setStep('review');
  }

  function getStepTitle(): string {
    if (step === 'address') return t('wallet.transferToAddress');
    if (step === 'amount') return t('wallet.transferAmount');
    if (step === 'review') return t('wallet.transferReviewFee');
    if (step === 'waiting') return t('wallet.transferSubmitting');
    return resultState?.success ? t('wallet.transferSuccess') : t('wallet.transferFailed');
  }

  function renderStepContent() {
    const addressPlaceholder = selectedChain?.symbol === 'BTC' ? 'bc1...' : '0x...';

    if (step === 'address') {
      return (
        <div className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.transferChain')}</span>
            <select
              className="select select-bordered w-full"
              value={networkKey}
              onChange={(event) => {
                setNetworkKey(event.target.value);
                setQuote(null);
              }}
              disabled={chainLocked || submitting || quoting}
            >
              {supportedChains.map((chain) => (
                <option key={chain.networkKey} value={chain.networkKey}>
                  {chain.name}
                </option>
              ))}
            </select>
          </label>

          {isTokenTransfer ? (
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
              <p className="m-0 text-base-content/70">{t('wallet.token')}</p>
              <p className="m-0 mt-1 font-semibold">{presetAsset?.tokenSymbol ?? t('wallet.token')}</p>
              <p className="m-0 mt-1 break-all text-base-content/60">{presetAsset?.tokenAddress}</p>
            </div>
          ) : null}

          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.transferToAddress')}</span>
            <input
              className="input input-bordered w-full"
              placeholder={addressPlaceholder}
              value={toAddress}
              onChange={(event) => {
                setToAddress(event.target.value);
                setQuote(null);
              }}
              disabled={submitting || quoting}
            />
          </label>

          <button type="button" className="btn btn-primary mt-2" disabled={submitting || quoting} onClick={() => void handleAddressNext()}>
            {t('wallet.transferNext')}
          </button>
        </div>
      );
    }

    if (step === 'amount') {
      return (
        <div className="mt-8 flex flex-col gap-4">
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.transferToAddress')}</p>
            <p className="m-0 mt-1 font-semibold break-all">{toAddress}</p>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.transferAmount')}</span>
            <input
              className="input input-bordered w-full"
              placeholder="0.0"
              value={amount}
              inputMode="decimal"
              onChange={(event) => {
                setAmount(event.target.value);
                setQuote(null);
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

    if (step === 'review') {
      return (
        <div className="mt-8 flex flex-col gap-4">
          {quote ? (
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
              <p className="m-0 text-base-content/70">{t('wallet.transferQuoteFee')}</p>
              <p className="m-0 mt-1 break-all font-semibold">{getDisplayFeeText(quote)}</p>
              {quote.insufficientFeeTokenBalance ? (
                <p className="m-0 mt-2 text-warning">
                  {t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(quote) })}
                </p>
              ) : null}
              <p className="m-0 mt-2 text-base-content/60">
                {t('wallet.transferToAddress')}: {truncateAddress(quote.toAddress)}
              </p>
              <p className="m-0 text-base-content/60">
                {t('wallet.transferAmount')}: {quote.amountInput}
              </p>
              <p className="m-0 text-base-content/60">
                {t('wallet.transferChain')}: {selectedChain?.name ?? quote.networkKey}
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
            disabled={submitting || quoting || Boolean(quote?.insufficientFeeTokenBalance)}
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

    if (step === 'waiting') {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <LoaderCircle size={56} className="animate-spin text-primary" />
          <p className="m-0 text-xl font-semibold">{t('wallet.transferSubmitting')}</p>
          <p className="m-0 text-sm text-base-content/70">{t('wallet.transferWaitingHint')}</p>
        </div>
      );
    }

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
              {t('wallet.transferToAddress')}: {truncateAddress(resultState.transfer?.toAddress ?? toAddress)}
            </p>
            <p className="m-0 mt-1 text-base-content/70">
              {t('wallet.transferAmount')}: {resultState.transfer?.amountInput ?? amount}
            </p>
            {resultState.transfer?.txHash ? (
              <p className="m-0 mt-1 break-all text-base-content/70">Tx: {resultState.transfer.txHash}</p>
            ) : null}
          </div>
        ) : (
          <p className="m-0 text-sm text-base-content/70">{resultState?.errorMessage}</p>
        )}
        <div className="mt-2 grid w-full grid-cols-2 gap-3">
          <button type="button" className="btn btn-outline" onClick={handleButtonClick(handleResultPrimaryAction)}>
            {resultState?.success ? t('wallet.transferDone') : t('wallet.transferRetry')}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleButtonClick(onClose)}>
            {t('common.close')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ModalContentScaffold
      title={t('wallet.transferTitle')}
      headerMeta={(
        <>
          <p className="m-0 text-sm text-base-content/70">{getStepTitle()}</p>
          <progress className="progress progress-primary mt-3 w-full" value={stepIndex} max={5} />
        </>
      )}
      bodyClassName="justify-start pt-8"
      stageClassName={stageClassName}
      showBack
      onBack={handleButtonClick(handleFooterBack)}
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
