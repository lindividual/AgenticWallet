import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, CircleHelp, Copy, Info, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import encodeQR from 'qr';
import type { AgentChatOpenRequest } from '../../agent/types';
import { useToast } from '../../contexts/ToastContext';

type ChainProtocol = 'evm' | 'svm' | 'tvm' | 'btc';

type ReceiveChain = {
  networkKey: string;
  chainId: number | null;
  name: string;
  symbol: string;
  marketChain?: string;
  protocol?: ChainProtocol;
};

type ReceiveCryptoContentProps = {
  walletAddress: string;
  chainAccounts?: Array<{
    networkKey: string;
    chainId: number | null;
    protocol?: ChainProtocol;
    address: string;
  }>;
  supportedChains: ReceiveChain[];
  onBack: () => void;
  onCopyAddress?: (address: string) => Promise<void> | void;
  onClose: () => void;
  onOpenAgentChat?: (request?: AgentChatOpenRequest) => void;
  footerVisible?: boolean;
  stageClassName?: string;
};

type ReceiveOption = {
  id: ChainProtocol;
  title: string;
  address: string;
  addressLabel: string;
  networkLabel: string;
  supportedChains: ReceiveChain[];
  sharedAddress: boolean;
};

const evmChainIcons = [
  { src: '/eth.svg' },
  { src: '/base.svg' },
  { src: '/bnb.svg' },
  { src: '/pol.jpeg' },
] as const;

const popularEvmMatchers = [
  /ethereum/i,
  /base/i,
  /bnb|bsc/i,
  /polygon/i,
  /arbitrum/i,
  /optimism/i,
  /avalanche/i,
] as const;

function getProtocolIconPath(protocol: ChainProtocol): string {
  if (protocol === 'svm') return '/sol.svg';
  if (protocol === 'tvm') return '/trx.svg';
  if (protocol === 'btc') return '/btc.svg';
  return '/eth.svg';
}

function truncateAddress(address: string, head = 6, tail = 6): string {
  if (!address) return '';
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

function joinChainNames(chains: ReceiveChain[], protocol?: ChainProtocol): string {
  return chains
    .filter((chain) => !protocol || chain.protocol === protocol)
    .map((chain) => chain.name.trim())
    .filter(Boolean)
    .join(', ');
}

function buildChainPreview(chains: ReceiveChain[], max = 4): { text: string; extraCount: number } {
  const names = chains.map((chain) => chain.name.trim()).filter(Boolean);
  if (names.length <= max) return { text: names.join(' / '), extraCount: 0 };
  return { text: names.slice(0, max).join(' / '), extraCount: names.length - max };
}

function formatSupportChainsText(
  t: ReturnType<typeof useTranslation>['t'],
  chains: ReceiveChain[],
  max = 4,
): string {
  const preview = buildChainPreview(chains, max);
  if (!preview.text) return '';
  const base = t('wallet.receiveAddressSupportsChains', { chains: preview.text });
  return preview.extraCount > 0 ? `${base} · +${preview.extraCount}` : base;
}

function isPopularEvmChain(name: string): boolean {
  return popularEvmMatchers.some((matcher) => matcher.test(name));
}

function slugifyLabel(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'receive'
  );
}

function ReceiveProtocolIcon({ protocol, alt }: { protocol: ChainProtocol; alt: string }) {
  if (protocol === 'evm') {
    return (
      <div
        role="img"
        aria-label={alt}
        className="grid h-11 w-11 grid-cols-2 gap-0.5 rounded-lg bg-base-200/70 p-1.5"
      >
        {evmChainIcons.map((icon) => (
          <span
            key={icon.src}
            className="flex h-full w-full items-center justify-center overflow-hidden rounded-[0.4rem] bg-white"
          >
            <img src={icon.src} alt="" aria-hidden className="h-3.5 w-3.5 object-contain" loading="lazy" />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={alt}
      className={[
        'flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg p-2',
        protocol === 'btc'
          ? 'bg-[#F7931A]'
          : protocol === 'tvm'
            ? 'bg-[#FF060A]'
            : 'bg-base-200/70',
      ].join(' ')}
    >
      <img
        src={getProtocolIconPath(protocol)}
        alt=""
        aria-hidden
        className={protocol === 'svm' ? 'h-full w-full object-contain' : 'h-7 w-7 object-contain'}
        loading="lazy"
      />
    </div>
  );
}

function getChainPillIconPath(chain: ReceiveChain): string | null {
  if (chain.networkKey === 'ethereum-mainnet') return '/eth.svg';
  if (chain.networkKey === 'base-mainnet') return '/base.svg';
  if (chain.networkKey === 'bnb-mainnet') return '/bnb.svg';
  if (chain.networkKey === 'polygon-mainnet') return '/pol.jpeg';
  return null;
}

function SecondaryActionButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="flex h-11 items-center justify-center gap-2 rounded-full bg-base-content px-5 text-sm font-medium text-base-100 transition hover:opacity-90"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function ReceiveCryptoContent({
  walletAddress,
  chainAccounts = [],
  supportedChains,
  onBack,
  onCopyAddress,
  onClose,
  onOpenAgentChat,
  footerVisible = true,
  stageClassName,
}: ReceiveCryptoContentProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [selectedAddressType, setSelectedAddressType] = useState<ChainProtocol | null>(null);
  const [isChainListOpen, setIsChainListOpen] = useState(false);
  const [chainQuery, setChainQuery] = useState('');

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  const receiveOptions = useMemo<ReceiveOption[]>(() => {
    const evmChains = supportedChains.filter((chain) => chain.protocol === 'evm');
    const tronChains = supportedChains.filter((chain) => chain.protocol === 'tvm');
    const solanaChains = supportedChains.filter((chain) => chain.protocol === 'svm');
    const bitcoinChains = supportedChains.filter((chain) => chain.protocol === 'btc');
    const evmAddress =
      chainAccounts.find((item) => (item.protocol ?? 'evm') === 'evm')?.address?.trim() || walletAddress.trim();
    const tronAddress = chainAccounts.find((item) => item.protocol === 'tvm')?.address?.trim() || '';
    const solanaAddress = chainAccounts.find((item) => item.protocol === 'svm')?.address?.trim() || '';
    const bitcoinAddress = chainAccounts.find((item) => item.protocol === 'btc')?.address?.trim() || '';

    const options: ReceiveOption[] = [
      {
        id: 'evm',
        title: t('wallet.receiveAddressTypeEvm'),
        address: evmAddress,
        addressLabel: t('wallet.receiveAddressTypeEvmLabel'),
        networkLabel:
          evmChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'EVM' }),
        supportedChains: evmChains,
        sharedAddress: true,
      },
      {
        id: 'svm',
        title: t('wallet.receiveAddressTypeSolana'),
        address: solanaAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeSolana') }),
        networkLabel:
          solanaChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Solana' }),
        supportedChains: solanaChains,
        sharedAddress: false,
      },
      {
        id: 'tvm',
        title: t('wallet.receiveAddressTypeTron'),
        address: tronAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeTron') }),
        networkLabel:
          tronChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Tron' }),
        supportedChains: tronChains,
        sharedAddress: false,
      },
      {
        id: 'btc',
        title: t('wallet.receiveAddressTypeBitcoin'),
        address: bitcoinAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeBitcoin') }),
        networkLabel:
          bitcoinChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Bitcoin' }),
        supportedChains: bitcoinChains,
        sharedAddress: false,
      },
    ];

    return options.filter((option) => option.address);
  }, [chainAccounts, supportedChains, t, walletAddress]);

  const selectedOption = useMemo(
    () => receiveOptions.find((option) => option.id === selectedAddressType) ?? null,
    [receiveOptions, selectedAddressType],
  );

  useEffect(() => {
    setIsChainListOpen(false);
    setChainQuery('');
  }, [selectedAddressType]);

  const displayAddress = selectedOption?.address ?? '';

  const qrCodeSvgMarkup = useMemo(() => {
    if (!displayAddress) return '';
    return encodeQR(displayAddress, 'svg', {
      border: 2,
      scale: 8,
    });
  }, [displayAddress]);

  const matchedChains = useMemo(() => {
    if (!selectedOption) return [];
    const normalizedQuery = chainQuery.trim().toLowerCase();
    if (!normalizedQuery) return selectedOption.supportedChains;
    return selectedOption.supportedChains.filter((chain) => {
      const haystack = `${chain.name} ${chain.symbol} ${chain.networkKey}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [chainQuery, selectedOption]);

  const chainGroups = useMemo(() => {
    if (!selectedOption) {
      return { popularChains: [] as ReceiveChain[], otherChains: [] as ReceiveChain[] };
    }
    if (selectedOption.id !== 'evm') {
      return { popularChains: [] as ReceiveChain[], otherChains: matchedChains };
    }
    return {
      popularChains: matchedChains.filter((chain) => isPopularEvmChain(chain.name)),
      otherChains: matchedChains.filter((chain) => !isPopularEvmChain(chain.name)),
    };
  }, [matchedChains, selectedOption]);

  const step: 'type' | 'address' = selectedAddressType ? 'address' : 'type';

  function handleBack() {
    if (selectedAddressType) {
      setSelectedAddressType(null);
      return;
    }
    onBack();
  }

  const receiveAgentRequest = useMemo<AgentChatOpenRequest>(() => {
    const evmAddress =
      chainAccounts.find((item) => (item.protocol ?? 'evm') === 'evm')?.address?.trim() || walletAddress.trim();
    const tronAddress = chainAccounts.find((item) => item.protocol === 'tvm')?.address?.trim() || '';
    const solanaAddress = chainAccounts.find((item) => item.protocol === 'svm')?.address?.trim() || '';
    const bitcoinAddress = chainAccounts.find((item) => item.protocol === 'btc')?.address?.trim() || '';

    return {
      intro: t('wallet.receiveAddressGuideAgentIntro'),
      prompt: t('wallet.receiveAddressGuideAgentPrompt'),
      contextOverrides: {
        receiveMode: 'true',
        receiveSupportedChains: joinChainNames(supportedChains),
        receiveSupportedEvmChains: joinChainNames(supportedChains, 'evm'),
        receiveSupportedTronChains: joinChainNames(supportedChains, 'tvm'),
        receiveSupportedSolanaChains: joinChainNames(supportedChains, 'svm'),
        receiveSupportedBitcoinChains: joinChainNames(supportedChains, 'btc'),
        ...(evmAddress ? { receiveAddressEvm: evmAddress } : {}),
        ...(tronAddress ? { receiveAddressTron: tronAddress } : {}),
        ...(solanaAddress ? { receiveAddressSolana: solanaAddress } : {}),
        ...(bitcoinAddress ? { receiveAddressBitcoin: bitcoinAddress } : {}),
      },
    };
  }, [chainAccounts, supportedChains, t, walletAddress]);

  async function handleCopyAddress() {
    if (!displayAddress || !selectedOption) {
      showError(t('wallet.addressUnavailable'));
      return;
    }
    try {
      if (onCopyAddress) {
        await onCopyAddress(displayAddress);
      } else {
        await navigator.clipboard.writeText(displayAddress);
      }
      showSuccess(t('wallet.receiveAddressCopiedForLabel', { label: selectedOption.addressLabel }));
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    }
  }

  const title = step === 'type' ? t('wallet.receiveSelectAddressTypeTitle') : null;
  const headerMeta = null;

  return (
    <div className={['flex h-full min-h-0 flex-1 flex-col overflow-hidden', stageClassName].filter(Boolean).join(' ')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {title ? (
          <header className="pb-6">
            <h2 className="m-0 text-4xl font-bold tracking-tight">{title}</h2>
            {headerMeta ? <div className="mt-3">{headerMeta}</div> : null}
          </header>
        ) : null}

        {step === 'type' ? (
          <div className="flex flex-col pb-4">
            {onOpenAgentChat ? (
              <button
                type="button"
                className="w-full border-b border-base-300/80 bg-transparent px-0 py-5 text-left transition hover:border-base-content/25"
                onClick={handleButtonClick(() => {
                  onOpenAgentChat(receiveAgentRequest);
                })}
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-base-200 text-base-content">
                    <CircleHelp size={22} aria-hidden />
                  </div>
                  <div>
                    <p className="m-0 text-base font-semibold text-base-content">
                      {t('wallet.receiveAddressGuideOptionTitle')}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-base-content/65">
                      {t('wallet.receiveAddressGuideOptionBody')}
                    </p>
                  </div>
                </div>
              </button>
            ) : null}

            {receiveOptions.map((option) => {
              const visibleNetworkPills = option.id === 'evm' ? option.supportedChains.slice(0, 3) : [];
              const hiddenNetworkCount = option.id === 'evm'
                ? Math.max(option.supportedChains.length - visibleNetworkPills.length, 0)
                : 0;

              return (
                <button
                  key={option.id}
                  type="button"
                  className="w-full border-b border-base-300/80 bg-transparent px-0 py-5 text-left transition hover:border-base-content/25"
                  onClick={handleButtonClick(() => setSelectedAddressType(option.id))}
                >
                  <div className="flex items-start gap-4">
                    <ReceiveProtocolIcon protocol={option.id} alt={option.title} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="m-0 text-lg font-semibold text-base-content">{option.title}</p>
                      </div>
                      <p className="mt-3 break-all font-mono text-sm text-base-content/80">{option.address}</p>
                      {option.id === 'evm' && visibleNetworkPills.length > 0 ? (
                        <div className="mt-3">
                          <p className="m-0 text-[11px] uppercase tracking-[0.18em] text-base-content/45">
                            {t('wallet.receiveCardSupportedNetworks')}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {visibleNetworkPills.map((chain) => {
                              const iconPath = getChainPillIconPath(chain);
                              return (
                                <span
                                  key={chain.networkKey}
                                  className="inline-flex items-center gap-1.5 rounded-full bg-base-200/80 px-3 py-1.5 text-xs text-base-content/80"
                                >
                                  {iconPath ? (
                                    <img
                                      src={iconPath}
                                      alt=""
                                      aria-hidden
                                      className="h-3.5 w-3.5 rounded-full object-cover"
                                      loading="lazy"
                                    />
                                  ) : null}
                                  <span>{chain.name}</span>
                                </span>
                              );
                            })}
                            {hiddenNetworkCount > 0 ? (
                              <span className="inline-flex items-center rounded-full bg-base-200/60 px-3 py-1.5 text-xs text-base-content/70">
                                +{hiddenNetworkCount} {t('common.more')}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : selectedOption ? (
          <div className="flex flex-col gap-4 pb-4">
            <div className="bg-transparent">
              {displayAddress ? (
                <div
                  aria-label={`${selectedOption.title} QR`}
                  className="mx-auto h-56 w-56 bg-white p-3 [&_svg]:h-full [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: qrCodeSvgMarkup }}
                />
              ) : null}

              <div className="mt-6 border-t border-base-300/80 pt-4">
                <p className="m-0 text-sm font-semibold tracking-[0.02em] text-primary">
                  {selectedOption.addressLabel}
                </p>
                <p className="mt-2 break-all font-mono text-sm leading-6 text-base-content">
                  {displayAddress || t('wallet.addressUnavailable')}
                </p>
              </div>

              <div className="mt-5">
                <SecondaryActionButton
                  icon={<Copy size={16} aria-hidden />}
                  label={t('wallet.copy')}
                  onClick={handleButtonClick(() => {
                    void handleCopyAddress();
                  })}
                />
              </div>
            </div>

            {selectedOption.sharedAddress ? (
              <div className="border-t border-base-300/80 pt-4">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left"
                  onClick={handleButtonClick(() => setIsChainListOpen((value) => !value))}
                >
                  <div>
                    <p className="m-0 text-base font-semibold text-base-content">
                      {t('wallet.receiveSupportedChainsTitle')}
                    </p>
                  </div>
                  <ChevronDown
                    size={18}
                    aria-hidden
                    className={`shrink-0 text-base-content/60 transition-transform ${
                      isChainListOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {isChainListOpen ? (
                  <div className="mt-4 space-y-4">
                    <label className="relative block">
                      <Search
                        size={16}
                        aria-hidden
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base-content/45"
                      />
                      <input
                        type="search"
                        value={chainQuery}
                        onChange={(event) => setChainQuery(event.target.value)}
                        className="input input-bordered w-full rounded-2xl pl-10 text-sm"
                        placeholder={t('wallet.receiveSupportedChainsSearchPlaceholder')}
                      />
                    </label>

                    {matchedChains.length === 0 ? (
                      <p className="m-0 bg-base-200/80 px-3 py-3 text-sm text-base-content/70">
                        {t('wallet.receiveSupportedChainsEmpty')}
                      </p>
                    ) : null}

                    {chainQuery.trim().length === 0 && chainGroups.popularChains.length > 0 ? (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/45">
                          {t('wallet.receiveSupportedChainsPopular')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {chainGroups.popularChains.map((chain) => (
                            <span
                              key={chain.networkKey}
                              className="rounded-full bg-base-200/80 px-3 py-2 text-sm text-base-content/80"
                            >
                              {chain.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {chainGroups.otherChains.length > 0 ? (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/45">
                          {chainQuery.trim().length === 0
                            ? t('wallet.receiveSupportedChainsAll')
                            : t('wallet.receiveSupportedChainsMatches')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {chainGroups.otherChains.map((chain) => (
                            <span
                              key={chain.networkKey}
                              className="rounded-full bg-base-200/55 px-3 py-2 text-sm text-base-content/80"
                            >
                              {chain.name}
                              <span className="ml-1 text-base-content/45">
                                {t('wallet.receiveSupportedChainsSameAddress')}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="bg-amber-50/70 px-4 py-3 text-amber-950">
              <div className="flex items-start gap-3">
                <Info size={18} className="mt-0.5 shrink-0 text-amber-700" aria-hidden />
                <div>
                  <p className="m-0 text-sm font-semibold">{t('wallet.receiveRiskTitle')}</p>
                  <p className="mt-1 text-sm leading-6 text-amber-900/80">
                    {selectedOption.sharedAddress
                      ? t('wallet.receiveSharedAddressRiskNotice')
                      : t('wallet.receiveDirectAddressRiskNotice', {
                          network: selectedOption.networkLabel,
                        })}
                  </p>
                </div>
              </div>
            </div>

          </div>
        ) : null}
      </div>

      {footerVisible ? (
        <div className="relative mt-auto shrink-0 flex items-center justify-center pt-6">
          <button
            type="button"
            className="btn btn-ghost absolute left-0 h-12 w-12 p-0 transition-none"
            onClick={handleButtonClick(handleBack)}
            aria-label={t('wallet.back')}
          >
            <ArrowLeft size={32} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn-ghost h-12 w-12 p-0 transition-none"
            aria-label={t('common.close')}
            onClick={handleButtonClick(onClose)}
          >
            <X size={26} aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
