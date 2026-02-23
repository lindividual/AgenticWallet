import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  USDT: ['ETH', 'BSC', 'BNB', 'BASE'],
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

export function ReceiveCryptoContent({
  walletAddress,
  supportedChains,
  onBack,
  onCopyAddress,
  onClose,
}: ReceiveCryptoContentProps) {
  const { t } = useTranslation();
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState<number | null>(null);

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

  const qrCodeUrl = useMemo(() => {
    if (!walletAddress || !selectedToken || !selectedChain) return '';

    const payload = `${selectedToken} (${selectedChain.name}): ${walletAddress}`;
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
  }, [walletAddress, selectedChain, selectedToken]);

  useEffect(() => {
    setSelectedChainId(null);
  }, [selectedToken]);

  const step: 'token' | 'chain' | 'address' = !selectedToken
    ? 'token'
    : selectedChainId === null
      ? 'chain'
      : 'address';
  const [displayStep, setDisplayStep] = useState<'token' | 'chain' | 'address'>(step);
  const [contentVisible, setContentVisible] = useState(true);

  useEffect(() => {
    if (step === displayStep) return;
    setContentVisible(false);
    const timer = setTimeout(() => {
      setDisplayStep(step);
      setContentVisible(true);
    }, 140);
    return () => clearTimeout(timer);
  }, [displayStep, step]);

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

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col justify-center">
        <header>
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

        <div className={`mt-16 transition-opacity duration-200 ${contentVisible ? 'opacity-100' : 'opacity-0'}`}>
          {displayStep === 'token' && (
            <div className="flex flex-col gap-2">
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
          )}

          {displayStep === 'chain' && (
            <div className="flex flex-col gap-2">
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
          )}

          {displayStep === 'address' && selectedToken && selectedChain && (
            <div className="flex flex-col gap-4 pt-2">
              <div className="flex items-center justify-between gap-2 text-sm text-base-content/70">
                <span>{selectedToken}</span>
                <span>{selectedChain.name}</span>
              </div>
              <p className="m-0 text-xl font-medium break-all">{walletAddress || t('wallet.addressUnavailable')}</p>
              {walletAddress ? (
                <img
                  src={qrCodeUrl}
                  alt={`${selectedToken}-${selectedChain.name} QR`}
                  className="h-56 w-56 self-center border border-base-300 bg-white p-2"
                  loading="lazy"
                />
              ) : null}
              <button
                type="button"
                className="btn btn-primary h-12 w-fit px-6 text-base font-semibold"
                onClick={handleButtonClick(onCopyAddress)}
              >
                {t('wallet.copy')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between pt-6">
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
