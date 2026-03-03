import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowUpDown, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ingestAgentEvent,
  quoteTrade,
  submitTrade,
  type TradeQuoteResponse,
  type TradeSubmitResponse,
} from '../../api';
import { useToast } from '../../contexts/ToastContext';
import type { TradeTokenPreset } from '../../utils/tradeTokens';

export type TradePreset = {
  mode: 'buy' | 'sell' | 'stableSwap';
  chainId: number;
  sellToken: TradeTokenPreset;
  buyToken: TradeTokenPreset;
  slippageBps?: number;
  assetSymbolForEvent?: string;
};

type TradeContentProps = {
  active: boolean;
  preset: TradePreset | null;
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
  onClose: () => void;
  onBack: () => void;
  onSubmitted?: (payload: TradeSubmitResponse) => void;
};

function formatRawAmount(rawAmount: string | null | undefined, decimals: number | null | undefined): string {
  if (!rawAmount) return '--';
  const normalizedDecimals = Number.isFinite(decimals) ? Number(decimals) : 18;
  if (normalizedDecimals < 0 || normalizedDecimals > 36) return '--';

  try {
    const raw = BigInt(rawAmount);
    const divisor = 10n ** BigInt(normalizedDecimals);
    const whole = raw / divisor;
    const fraction = raw % divisor;
    if (fraction === 0n) return whole.toString();
    const fractionText = fraction.toString().padStart(normalizedDecimals, '0').replace(/0+$/, '').slice(0, 8);
    return `${whole.toString()}.${fractionText}`;
  } catch {
    return '--';
  }
}

function truncateAddress(address: string): string {
  if (!address || address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function TradeContent({
  active,
  preset,
  supportedChains,
  onClose,
  onBack,
  onSubmitted,
}: TradeContentProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [sellToken, setSellToken] = useState<TradeTokenPreset | null>(null);
  const [buyToken, setBuyToken] = useState<TradeTokenPreset | null>(null);
  const [chainId, setChainId] = useState<number>(1);
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [sellAmount, setSellAmount] = useState('');
  const [quote, setQuote] = useState<TradeQuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!active || !preset) return;
    setChainId(preset.chainId);
    setSellToken({ ...preset.sellToken });
    setBuyToken({ ...preset.buyToken });
    setSlippageBps(Number.isFinite(Number(preset.slippageBps)) ? Number(preset.slippageBps) : 100);
    setSellAmount('');
    setQuote(null);
    setQuoting(false);
    setSubmitting(false);
  }, [active, preset]);

  const selectedChain = useMemo(
    () => supportedChains.find((item) => item.chainId === chainId) ?? null,
    [chainId, supportedChains],
  );

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  function getTitle(): string {
    if (!preset) return t('wallet.tradeSwapTitle');
    if (preset.mode === 'buy') return t('wallet.tradeBuyTitle');
    if (preset.mode === 'sell') return t('wallet.tradeSellTitle');
    return t('wallet.tradeStableTitle');
  }

  function getEstimatedFeeText(nextQuote: TradeQuoteResponse): string {
    if (!nextQuote.estimatedFeeWei) return t('wallet.transferQuoteUnavailable');
    const normalized = formatRawAmount(nextQuote.estimatedFeeWei, 18);
    if (normalized === '--') return nextQuote.estimatedFeeWei;
    return `${normalized} ${selectedChain?.symbol ?? ''}`.trim();
  }

  function flipStablePair(): void {
    if (!preset || preset.mode !== 'stableSwap' || !sellToken || !buyToken) return;
    setSellToken(buyToken);
    setBuyToken(sellToken);
    setQuote(null);
  }

  async function handleQuote(): Promise<void> {
    if (!sellToken || !buyToken || !sellAmount.trim()) {
      showError(t('wallet.tradeFillRequired'));
      return;
    }

    const requestPayload = {
      chainId,
      sellTokenAddress: sellToken.address,
      buyTokenAddress: buyToken.address,
      sellAmount: sellAmount.trim(),
      sellTokenSymbol: sellToken.symbol,
      buyTokenSymbol: buyToken.symbol,
      sellTokenDecimals: sellToken.decimals,
      buyTokenDecimals: buyToken.decimals,
      slippageBps,
    };

    setQuoting(true);
    try {
      const nextQuote = await quoteTrade(requestPayload);
      setQuote(nextQuote);
    } catch (error) {
      setQuote(null);
      showError(`${t('wallet.tradeFailed')}: ${(error as Error).message}`);
    } finally {
      setQuoting(false);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!quote) {
      await handleQuote();
      return;
    }

    if (!sellToken || !buyToken) {
      showError(t('wallet.tradeFillRequired'));
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitTrade({
        chainId,
        sellTokenAddress: sellToken.address,
        buyTokenAddress: buyToken.address,
        sellAmount: quote.sellAmountInput,
        sellTokenSymbol: sellToken.symbol,
        buyTokenSymbol: buyToken.symbol,
        sellTokenDecimals: sellToken.decimals,
        buyTokenDecimals: buyToken.decimals,
        slippageBps,
      });

      if (result.status === 'failed') {
        showError(t('wallet.tradeSubmitFailed'));
        return;
      }

      if (preset?.mode === 'buy') {
        ingestAgentEvent('trade_buy', {
          chainId,
          asset: preset.assetSymbolForEvent ?? buyToken.symbol,
          sellToken: sellToken.symbol,
          buyToken: buyToken.symbol,
        }).catch(() => undefined);
      }
      if (preset?.mode === 'sell') {
        ingestAgentEvent('trade_sell', {
          chainId,
          asset: preset.assetSymbolForEvent ?? sellToken.symbol,
          sellToken: sellToken.symbol,
          buyToken: buyToken.symbol,
        }).catch(() => undefined);
      }

      onSubmitted?.(result);
      showSuccess(t('wallet.tradeSuccess'));
      onClose();
    } catch (error) {
      showError(`${t('wallet.tradeFailed')}: ${(error as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col justify-start pt-8">
        <header>
          <h2 className="m-0 text-4xl font-bold tracking-tight">{getTitle()}</h2>
        </header>

        <div className="mt-8 flex flex-col gap-4">
          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.transferChain')}</p>
            <p className="m-0 mt-1 font-semibold">{selectedChain?.name ?? chainId}</p>
          </div>

          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.tradeFromToken')}</p>
            <p className="m-0 mt-1 font-semibold">{sellToken?.symbol ?? '--'}</p>
            <p className="m-0 mt-1 break-all text-base-content/60">{truncateAddress(sellToken?.address ?? '')}</p>
          </div>

          {preset?.mode === 'stableSwap' ? (
            <button type="button" className="btn btn-outline" onClick={flipStablePair}>
              <ArrowUpDown size={16} />
              {t('wallet.tradeFlipPair')}
            </button>
          ) : null}

          <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
            <p className="m-0 text-base-content/70">{t('wallet.tradeToToken')}</p>
            <p className="m-0 mt-1 font-semibold">{buyToken?.symbol ?? '--'}</p>
            <p className="m-0 mt-1 break-all text-base-content/60">{truncateAddress(buyToken?.address ?? '')}</p>
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.tradeSellAmount')}</span>
            <input
              className="input input-bordered w-full"
              placeholder="0.0"
              value={sellAmount}
              inputMode="decimal"
              onChange={(event) => {
                setSellAmount(event.target.value);
                setQuote(null);
              }}
              disabled={quoting || submitting}
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm text-base-content/70">{t('wallet.tradeSlippage')}</span>
            <input
              className="input input-bordered w-full"
              placeholder="100"
              value={String(slippageBps)}
              inputMode="numeric"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (!Number.isFinite(next)) {
                  setSlippageBps(100);
                  setQuote(null);
                  return;
                }
                setSlippageBps(Math.max(5, Math.min(3000, Math.floor(next))));
                setQuote(null);
              }}
              disabled={quoting || submitting}
            />
          </label>

          {quote ? (
            <div className="rounded-2xl border border-base-300 bg-base-100 p-4 text-sm">
              <p className="m-0 text-base-content/70">{t('wallet.tradeExpectedReceive')}</p>
              <p className="m-0 mt-1 break-all font-semibold">
                {formatRawAmount(quote.expectedBuyAmountRaw, quote.buyTokenDecimals)} {quote.buyTokenSymbol ?? buyToken?.symbol ?? ''}
              </p>
              <p className="m-0 mt-2 text-base-content/60">
                {t('wallet.transferQuoteFee')}: {getEstimatedFeeText(quote)}
              </p>
              {quote.needsApproval ? (
                <p className="m-0 mt-2 text-warning">{t('wallet.tradeApprovalRequired')}</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 grid grid-cols-2 gap-3">
            <button type="button" className="btn btn-outline" disabled={quoting || submitting} onClick={() => void handleQuote()}>
              {quoting ? <LoaderCircle size={16} className="animate-spin" /> : null}
              {t('wallet.tradeReview')}
            </button>
            <button type="button" className="btn btn-primary" disabled={quoting || submitting} onClick={() => void handleSubmit()}>
              {submitting ? <LoaderCircle size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              {submitting ? t('wallet.tradeSubmitting') : t('wallet.tradeSubmit')}
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
