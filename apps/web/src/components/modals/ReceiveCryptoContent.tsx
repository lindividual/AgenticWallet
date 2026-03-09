import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, Clock3, Copy, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import encodeQR from 'qr';
import { AssetListItem } from '../AssetListItem';

type ReceiveCryptoContentProps = {
  walletAddress: string;
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
  onBack: () => void;
  onCopyAddress: () => void;
  onClose: () => void;
};

const DEFAULT_RECEIVE_TOKENS = ['USDT', 'USDC', 'ETH', 'BNB'] as const;

const TOKEN_CHAIN_MATCHERS: Record<(typeof DEFAULT_RECEIVE_TOKENS)[number], string[]> = {
  USDT: ['ETH', 'BSC', 'BNB'],
  USDC: ['ETH', 'BSC', 'BNB', 'BASE'],
  ETH: ['ETH', 'BASE'],
  BNB: ['BSC', 'BNB'],
};

function getTokenIconPath(token: string): string | null {
  const map: Record<string, string> = {
    USDT: '/usdt.svg',
    USDC: '/usdc.svg',
    ETH: '/eth.svg',
    BNB: '/bnb.svg',
  };
  return map[token.toUpperCase()] ?? null;
}

function getChainIconPath(chainName: string, chainSymbol: string): string | null {
  const haystack = `${chainName} ${chainSymbol}`.toUpperCase();
  if (haystack.includes('BSC') || haystack.includes('BNB')) return '/bnb.svg';
  if (haystack.includes('BASE')) return '/base.svg';
  if (haystack.includes('ETH')) return '/eth.svg';
  return null;
}

function truncateAddress(address: string, head = 6, tail = 6): string {
  if (!address) return '';
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function ReceiveCryptoContent({
  walletAddress,
  supportedChains,
  onBack,
  onCopyAddress,
  onClose,
}: ReceiveCryptoContentProps) {
  const MIN_CONTENT_HEIGHT = 320;
  const { t } = useTranslation();
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const tokenListRef = useRef<HTMLDivElement | null>(null);
  const chainListRef = useRef<HTMLDivElement | null>(null);
  const addressContentRef = useRef<HTMLDivElement | null>(null);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  const availableChains = useMemo(() => {
    if (!selectedToken) return [];

    const matchers = TOKEN_CHAIN_MATCHERS[selectedToken as keyof typeof TOKEN_CHAIN_MATCHERS] ?? [];
    const matched = supportedChains.filter((chain) => {
      const haystack = `${chain.symbol} ${chain.name}`.toUpperCase();
      return matchers.some((matcher) => haystack.includes(matcher));
    });

    return matched.length > 0 ? matched : supportedChains;
  }, [selectedToken, supportedChains]);

  const selectedChain = useMemo(
    () => availableChains.find((chain) => chain.chainId === selectedChainId) ?? null,
    [availableChains, selectedChainId],
  );

  const qrCodeSvgMarkup = useMemo(() => {
    if (!walletAddress) return '';

    return encodeQR(walletAddress, 'svg', {
      border: 2,
      scale: 8,
    });
  }, [walletAddress]);

  useEffect(() => {
    setSelectedChainId(null);
  }, [selectedToken]);

  const step: 'token' | 'chain' | 'address' = !selectedToken
    ? 'token'
    : selectedChainId === null
      ? 'chain'
      : 'address';

  function handleBack() {
    if (selectedChainId !== null) {
      setSelectedChainId(null);
      return;
    }
    if (selectedToken) {
      setSelectedToken(null);
      return;
    }
    onBack();
  }

  useEffect(() => {
    function updateContentHeight() {
      const rootHeight = rootRef.current?.clientHeight ?? window.innerHeight;
      const headerHeight = headerRef.current?.offsetHeight ?? 0;
      const footerHeight = footerRef.current?.offsetHeight ?? 0;
      const contentTopGap = 64;
      const topPadding = 32;
      const availableHeight = Math.max(
        rootHeight - topPadding - headerHeight - footerHeight - contentTopGap,
        220,
      );

      const activeEl =
        step === 'token' ? tokenListRef.current : step === 'chain' ? chainListRef.current : addressContentRef.current;
      const desiredHeight = activeEl?.scrollHeight ?? availableHeight;
      const nextHeight =
        desiredHeight > MIN_CONTENT_HEIGHT ? availableHeight : Math.min(MIN_CONTENT_HEIGHT, availableHeight);
      setContentHeight(nextHeight);
    }

    const rafId = requestAnimationFrame(updateContentHeight);
    window.addEventListener('resize', updateContentHeight);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateContentHeight);
    };
  }, [step, availableChains.length, selectedToken, selectedChainId, walletAddress, MIN_CONTENT_HEIGHT]);

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col justify-start pt-8">
        <header ref={headerRef}>
          <div className="relative h-11 overflow-hidden">
            <h2
              className={`absolute inset-0 m-0 text-4xl font-bold tracking-tight transition-all duration-300 ${
                step === 'token' ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-4 opacity-0'
              }`}
            >
              {t('wallet.receiveSelectTokenTitle')}
            </h2>
            <h2
              className={`absolute inset-0 m-0 text-4xl font-bold tracking-tight transition-all duration-300 ${
                step === 'chain'
                  ? 'translate-x-0 opacity-100'
                  : step === 'token'
                    ? 'pointer-events-none translate-x-4 opacity-0'
                    : 'pointer-events-none -translate-x-4 opacity-0'
              }`}
            >
              {t('wallet.receiveSelectNetworkTitle', { token: selectedToken ?? '' })}
            </h2>
            <h2
              className={`absolute inset-0 m-0 text-4xl font-bold tracking-tight transition-all duration-300 ${
                step === 'address' ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              {t('wallet.receiveTransferToAddressTitle')}
            </h2>
          </div>
        </header>

        <div className="relative mt-16 min-h-0 overflow-hidden" style={{ height: `${contentHeight}px` }}>
          <div
            className={`absolute inset-0 transition-all duration-300 ${
              step === 'token' ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-4 opacity-0'
            }`}
          >
            <div className="h-full min-h-0 overflow-y-auto">
              <div ref={tokenListRef} className="flex flex-col gap-2 pr-1 pb-1">
              {DEFAULT_RECEIVE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  className="w-full cursor-pointer text-left"
                  onClick={handleButtonClick(() => setSelectedToken(token))}
                >
                  <AssetListItem
                    className="py-3"
                    leftIcon={
                      <img
                        src={getTokenIconPath(token) ?? ''}
                        alt={token}
                        className="h-8 w-8 rounded-full bg-base-300 object-cover"
                        loading="lazy"
                      />
                    }
                    leftPrimary={token}
                  />
                </button>
              ))}
              </div>
            </div>
          </div>

          <div
            className={`absolute inset-0 transition-all duration-300 ${
              step === 'chain'
                ? 'translate-x-0 opacity-100'
                : step === 'token'
                  ? 'pointer-events-none translate-x-4 opacity-0'
                  : 'pointer-events-none -translate-x-4 opacity-0'
            }`}
          >
            <div className="h-full min-h-0 overflow-y-auto">
              <div ref={chainListRef} className="flex flex-col gap-2 pr-1 pb-1">
              {availableChains.map((chain) => (
                <button
                  key={chain.chainId}
                  type="button"
                  className="w-full cursor-pointer text-left"
                  onClick={handleButtonClick(() => setSelectedChainId(chain.chainId))}
                >
                  <AssetListItem
                    className="py-3"
                    leftIcon={
                      <img
                        src={getChainIconPath(chain.name, chain.symbol) ?? getTokenIconPath(selectedToken ?? '') ?? ''}
                        alt={chain.name}
                        className="h-8 w-8 rounded-full bg-base-300 object-cover"
                        loading="lazy"
                      />
                    }
                    leftPrimary={chain.name}
                  />
                </button>
              ))}
              </div>
            </div>
          </div>

          <div
            className={`absolute inset-0 transition-all duration-300 ${
              step === 'address' ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-4 opacity-0'
            }`}
          >
            {selectedToken && selectedChain ? (
              <div className="h-full min-h-0 overflow-y-auto">
                <div ref={addressContentRef} className="flex flex-col gap-4 pr-1 pt-2 pb-1">
                  <div className="space-y-1">
                    <p className="m-0 text-3xl font-bold tracking-tight">{t('wallet.receiveTokenTitle', { token: selectedToken })}</p>
                    <p className="m-0 text-base text-base-content/60">
                      {t('wallet.receiveOnNetwork', { network: selectedChain.name })}
                    </p>
                  </div>

                  <div className="rounded-3xl border border-base-300 bg-base-200 p-4">
                    <div className="mb-4 flex items-center justify-between gap-2">
                      <span className="rounded-full bg-base-100 px-3 py-1 text-sm font-medium">{selectedToken}</span>
                      <span className="rounded-full bg-base-100 px-3 py-1 text-sm text-base-content/70">
                        {selectedChain.name}
                      </span>
                    </div>
                    {walletAddress ? (
                      <div
                        aria-label={`${selectedToken}-${selectedChain.name} QR`}
                        className="mx-auto h-56 w-56 rounded-2xl border border-base-300 bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                        dangerouslySetInnerHTML={{ __html: qrCodeSvgMarkup }}
                      />
                    ) : null}
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-base-100 px-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 text-xs text-base-content/60">{t('wallet.receiveAddressLabel')}</p>
                        <p className="m-0 truncate text-sm font-medium">
                          {walletAddress ? truncateAddress(walletAddress) : t('wallet.addressUnavailable')}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-circle btn-ghost h-10 min-h-0 w-10"
                        aria-label={t('wallet.copy')}
                        onClick={handleButtonClick(onCopyAddress)}
                      >
                        <Copy size={18} aria-hidden />
                      </button>
                    </div>
                  </div>

                  <div className="border-t border-base-300 pt-4">
                    <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm text-base-content/80">
                      <li className="flex items-start gap-3">
                        <Info size={18} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden />
                        <span>{t('wallet.receiveOnlyTokenNotice', { token: selectedToken })}</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <ArrowDownToLine size={18} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden />
                        <span>
                          {t('wallet.receiveOnlyNetworkNotice', {
                            token: selectedToken,
                            network: selectedChain.name,
                          })}
                        </span>
                      </li>
                      <li className="flex items-start gap-3">
                        <Clock3 size={18} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden />
                        <span>{t('wallet.receiveProcessingTimeNotice', { minutes: 3 })}</span>
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div ref={footerRef} className="mt-auto shrink-0 flex items-center justify-between pt-6">
        <button
          type="button"
          className="btn btn-ghost h-12 w-12 p-0"
          onClick={handleButtonClick(handleBack)}
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
