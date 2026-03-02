import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ArrowLeft, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { quoteTransfer, submitTransfer, type TransferQuoteResponse, type TransferRecord } from '../../api';
import { useToast } from '../../contexts/ToastContext';

type TransferContentProps = {
  active: boolean;
  presetAsset?: {
    chainId: number;
    tokenAddress: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
  } | null;
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
  onClose: () => void;
  onBack: () => void;
  onSubmitted: (transfer: TransferRecord) => void;
};

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
}: TransferContentProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [chainId, setChainId] = useState<number>(supportedChains[0]?.chainId ?? 1);
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<TransferQuoteResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const isTokenTransfer = Boolean(presetAsset?.tokenAddress);

  useEffect(() => {
    if (!active) return;
    setChainId(presetAsset?.chainId ?? supportedChains[0]?.chainId ?? 1);
    setToAddress('');
    setAmount('');
    setQuote(null);
    setSubmitting(false);
    setQuoting(false);
  }, [active, supportedChains, presetAsset]);

  const selectedChain = useMemo(
    () => supportedChains.find((item) => item.chainId === chainId) ?? supportedChains[0] ?? null,
    [chainId, supportedChains],
  );

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
    if (!toAddress.trim() || !amount.trim()) {
      showError(t('wallet.transferFillRequired'));
      return;
    }

    const requestPayload = {
      chainId,
      toAddress: toAddress.trim(),
      amount: amount.trim(),
      tokenAddress: presetAsset?.tokenAddress,
      tokenSymbol: presetAsset?.tokenSymbol,
      tokenDecimals: presetAsset?.tokenDecimals,
    };
    console.log('[wallet-ui][transfer/quote] request', requestPayload);

    setQuoting(true);
    try {
      const nextQuote = await quoteTransfer(requestPayload);
      setQuote(nextQuote);
      console.log('[wallet-ui][transfer/quote] success', {
        chainId: nextQuote.chainId,
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

  async function handleSubmit() {
    if (!quote) {
      await handleQuote();
      return;
    }

    setSubmitting(true);
    try {
      if (quote.insufficientFeeTokenBalance) {
        showError(t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(quote) }));
        return;
      }

      const submitPayload = {
        chainId: quote.chainId,
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
        chainId: result.transfer.chainId,
      });

      onSubmitted(result.transfer);
      showSuccess(t('wallet.transferSuccess'));
      onClose();
    } catch (error) {
      console.error('[wallet-ui][transfer/submit] failed', {
        chainId: quote.chainId,
        toAddress: quote.toAddress,
        tokenAddress: quote.tokenAddress,
        tokenSymbol: quote.tokenSymbol,
        tokenDecimals: quote.tokenDecimals,
        amountInput: quote.amountInput,
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      showError(`${t('wallet.transferFailed')}: ${(error as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col justify-start pt-8">
        <header>
          <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.transferTitle')}</h2>
        </header>

        <div className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.transferChain')}</span>
            <select
              className="select select-bordered w-full"
              value={chainId}
              onChange={(event) => {
                const next = Number(event.target.value);
                setChainId(next);
                setQuote(null);
              }}
              disabled={submitting || quoting || isTokenTransfer}
            >
              {supportedChains.map((chain) => (
                <option key={chain.chainId} value={chain.chainId}>
                  {chain.name} ({chain.symbol})
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
              placeholder="0x..."
              value={toAddress}
              onChange={(event) => {
                setToAddress(event.target.value);
                setQuote(null);
              }}
              disabled={submitting || quoting}
            />
          </label>

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

          {quote && (
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
              <p className="m-0 text-base-content/70">{t('wallet.transferQuoteFee')}</p>
              <p className="m-0 mt-1 font-semibold break-all">
                {getDisplayFeeText(quote)}
              </p>
              {quote.insufficientFeeTokenBalance ? (
                <p className="m-0 mt-2 text-warning">{t('wallet.transferInsufficientFeeTokenBalanceWithFee', { fee: getDisplayFeeText(quote) })}</p>
              ) : null}
              <p className="m-0 mt-2 text-base-content/60">
                {t('wallet.transferToAddress')}: {truncateAddress(quote.toAddress)}
              </p>
              <p className="m-0 text-base-content/60">
                {t('wallet.transferChain')}: {selectedChain?.name ?? quote.chainId}
              </p>
            </div>
          )}

          <div className="mt-2 grid grid-cols-2 gap-3">
            <button
              type="button"
              className="btn btn-outline"
              disabled={submitting || quoting}
              onClick={() => {
                void handleQuote();
              }}
            >
              {quoting ? <LoaderCircle size={16} className="animate-spin" /> : null}
              {t('wallet.transferReviewFee')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || quoting || Boolean(quote?.insufficientFeeTokenBalance)}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {submitting ? <LoaderCircle size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              {submitting ? t('wallet.transferSubmitting') : t('wallet.transferConfirm')}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between pt-6">
        <button
          type="button"
          className="btn btn-ghost h-12 w-12 p-0"
          onClick={handleButtonClick(onBack)}
          aria-label={t('wallet.back')}
        >
          <ArrowLeft size={32} aria-hidden />
        </button>
        <button
          type="button"
          className="btn btn-ghost h-12 w-12 p-0"
          aria-label={t('common.close')}
          onClick={handleButtonClick(onClose)}
        >
          <X size={26} aria-hidden />
        </button>
      </div>
    </div>
  );
}
