import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, CircleHelp, Copy, Download, Info, Search, Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import encodeQR from 'qr';
import type { AgentChatOpenRequest } from '../../agent/types';
import { useToast } from '../../contexts/ToastContext';
import { ModalContentScaffold } from './ModalContentScaffold';

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
  summary: string;
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
        className="grid h-12 w-12 grid-cols-2 gap-0.5 rounded-2xl border border-base-300 bg-base-100 p-1.5"
      >
        {evmChainIcons.map((icon) => (
          <span
            key={icon.src}
            className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-white"
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
        'flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl p-2',
        protocol === 'btc'
          ? 'border border-[#F7931A] bg-[#F7931A]'
          : protocol === 'tvm'
            ? 'border border-[#FF060A] bg-[#FF060A]'
            : 'border border-base-300 bg-base-100',
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
      className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-base-300 bg-base-100 px-4 text-sm font-medium text-base-content transition hover:bg-base-200"
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
  const { showError, showInfo, showSuccess } = useToast();
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
        summary: t('wallet.receiveAddressSharedSummary'),
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
        summary: t('wallet.receiveAddressSingleSummary', { network: t('wallet.receiveAddressTypeSolana') }),
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
        summary: t('wallet.receiveAddressSingleSummary', { network: t('wallet.receiveAddressTypeTron') }),
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
        summary: t('wallet.receiveAddressSingleSummary', { network: t('wallet.receiveAddressTypeBitcoin') }),
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

  async function handleShareAddress() {
    if (!selectedOption || !displayAddress) {
      showError(t('wallet.addressUnavailable'));
      return;
    }

    const supportedLine = selectedOption.sharedAddress
      ? formatSupportChainsText(t, selectedOption.supportedChains, 5)
      : selectedOption.networkLabel;
    const sharePayload = {
      title: t('wallet.receiveShareTitle', { network: selectedOption.title }),
      text: [t('wallet.receiveShareTitle', { network: selectedOption.title }), displayAddress, supportedLine]
        .filter(Boolean)
        .join('\n'),
    };

    try {
      if (navigator.share) {
        await navigator.share(sharePayload);
        showSuccess(t('home.shareSuccess'));
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sharePayload.text);
        showSuccess(t('home.shareCopied'));
        return;
      }
      showError(t('home.shareNotSupported'));
    } catch {
      showInfo(t('home.shareCanceled'));
    }
  }

  function handleDownloadQr() {
    if (!selectedOption || !qrCodeSvgMarkup) {
      showError(t('wallet.addressUnavailable'));
      return;
    }

    try {
      const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${qrCodeSvgMarkup}`], {
        type: 'image/svg+xml;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `umi-wallet-${slugifyLabel(selectedOption.title)}-qr.svg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showSuccess(t('wallet.receiveQrSaved'));
    } catch (error) {
      showError(`${t('common.error')}: ${(error as Error).message}`);
    }
  }

  const title =
    step === 'type'
      ? t('wallet.receiveSelectAddressTypeTitle')
      : t('wallet.receiveAddressScreenTitle', { network: selectedOption?.title ?? '' });
  const headerMeta =
    step === 'type' ? (
      <p className="m-0 max-w-sm text-sm leading-6 text-base-content/70">
        {t('wallet.receiveSelectAddressTypeSubtitle')}
      </p>
    ) : selectedOption ? (
      <div className="space-y-2">
        <div className="badge badge-outline h-7 rounded-full border-base-300 px-3 text-xs font-medium">
          {selectedOption.addressLabel}
        </div>
        <p className="m-0 max-w-md text-sm leading-6 text-base-content/70">
          {selectedOption.sharedAddress
            ? t('wallet.receiveAddressSharedDetailSubtitle')
            : t('wallet.receiveAddressSingleDetailSubtitle', { network: selectedOption.networkLabel })}
        </p>
      </div>
    ) : null;

  return (
    <ModalContentScaffold
      title={title}
      headerMeta={headerMeta}
      bodyClassName="justify-start"
      contentClassName="mt-6 flex min-h-0 flex-1 flex-col"
      stageClassName={stageClassName}
      showBack
      onBack={handleButtonClick(handleBack)}
      backAriaLabel={t('wallet.back')}
      onClose={handleButtonClick(onClose)}
      closeAriaLabel={t('common.close')}
      footerVisible={footerVisible}
    >
      {step === 'type' ? (
        <div className="flex flex-col gap-3">
          {onOpenAgentChat ? (
            <button
              type="button"
              className="w-full rounded-[1.75rem] border border-dashed border-base-300 bg-base-100 px-4 py-4 text-left transition hover:bg-base-200"
              onClick={handleButtonClick(() => {
                onOpenAgentChat(receiveAgentRequest);
              })}
            >
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <CircleHelp size={22} aria-hidden />
                </div>
                <div>
                  <p className="m-0 text-base font-semibold text-base-content">
                    {t('wallet.receiveAddressGuideOptionTitle')}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-base-content/70">
                    {t('wallet.receiveAddressGuideOptionBody')}
                  </p>
                </div>
              </div>
            </button>
          ) : null}

          {receiveOptions.map((option) => {
            const supportsText = option.sharedAddress
              ? formatSupportChainsText(t, option.supportedChains)
              : option.networkLabel;

            return (
              <button
                key={option.id}
                type="button"
                className="w-full rounded-[1.75rem] border border-base-300 bg-base-100 p-4 text-left transition hover:border-base-content/20 hover:bg-base-200"
                onClick={handleButtonClick(() => setSelectedAddressType(option.id))}
              >
                <div className="flex items-start gap-4">
                  <ReceiveProtocolIcon protocol={option.id} alt={option.title} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="m-0 text-lg font-semibold text-base-content">{option.title}</p>
                        <p className="mt-1 text-sm leading-6 text-base-content/70">{option.summary}</p>
                      </div>
                      {option.supportedChains.length > 1 ? (
                        <span className="rounded-full bg-base-200 px-2.5 py-1 text-xs font-medium text-base-content/65">
                          {t('wallet.multiChainCount', { count: option.supportedChains.length })}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 rounded-2xl bg-base-200/70 px-3 py-2">
                      <p className="m-0 text-xs uppercase tracking-[0.18em] text-base-content/45">
                        {option.addressLabel}
                      </p>
                      <p className="mt-1 font-mono text-sm text-base-content/80">
                        {truncateAddress(option.address, 8, 8)}
                      </p>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-base-content/65">{supportsText}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : selectedOption ? (
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 py-2">
            <div className="rounded-[2rem] border border-base-300 bg-base-200 p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="m-0 text-sm font-medium text-base-content/65">
                    {selectedOption.sharedAddress
                      ? t('wallet.receiveAddressSharedBadge')
                      : t('wallet.receiveAddressDirectBadge')}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-base-content">{selectedOption.addressLabel}</p>
                </div>
                <span className="rounded-full bg-base-100 px-3 py-1 text-xs font-medium text-base-content/70">
                  {selectedOption.title}
                </span>
              </div>

              {displayAddress ? (
                <div
                  aria-label={`${selectedOption.title} QR`}
                  className="mx-auto h-56 w-56 rounded-[1.75rem] border border-base-300 bg-white p-2 shadow-sm [&_svg]:h-full [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: qrCodeSvgMarkup }}
                />
              ) : null}

              <div className="mt-4 rounded-[1.75rem] bg-base-100 px-4 py-4">
                <p className="m-0 text-xs uppercase tracking-[0.18em] text-base-content/45">
                  {t('wallet.receiveAddressLabel')}
                </p>
                <p className="mt-2 break-all font-mono text-sm leading-6 text-base-content">
                  {displayAddress || t('wallet.addressUnavailable')}
                </p>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <SecondaryActionButton
                  icon={<Copy size={16} aria-hidden />}
                  label={t('wallet.copy')}
                  onClick={handleButtonClick(() => {
                    void handleCopyAddress();
                  })}
                />
                <SecondaryActionButton
                  icon={<Share2 size={16} aria-hidden />}
                  label={t('wallet.receiveShareAction')}
                  onClick={handleButtonClick(() => {
                    void handleShareAddress();
                  })}
                />
                <SecondaryActionButton
                  icon={<Download size={16} aria-hidden />}
                  label={t('wallet.receiveSaveQrAction')}
                  onClick={handleButtonClick(handleDownloadQr)}
                />
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-base-300 bg-base-100 p-4">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={handleButtonClick(() => setIsChainListOpen((value) => !value))}
              >
                <div>
                  <p className="m-0 text-base font-semibold text-base-content">
                    {selectedOption.sharedAddress
                      ? t('wallet.receiveSupportedChainsTitle')
                      : t('wallet.receiveNetworkTitle')}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-base-content/70">
                    {selectedOption.sharedAddress
                      ? t('wallet.receiveSupportedChainsSubtitle')
                      : selectedOption.networkLabel}
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
                  {selectedOption.sharedAddress ? (
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
                  ) : null}

                  {matchedChains.length === 0 ? (
                    <p className="m-0 rounded-2xl bg-base-200 px-3 py-3 text-sm text-base-content/70">
                      {t('wallet.receiveSupportedChainsEmpty')}
                    </p>
                  ) : null}

                  {selectedOption.sharedAddress && chainQuery.trim().length === 0 && chainGroups.popularChains.length > 0 ? (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-base-content/45">
                        {t('wallet.receiveSupportedChainsPopular')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {chainGroups.popularChains.map((chain) => (
                          <span
                            key={chain.networkKey}
                            className="rounded-full bg-base-200 px-3 py-2 text-sm text-base-content/80"
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
                        {selectedOption.sharedAddress && chainQuery.trim().length === 0
                          ? t('wallet.receiveSupportedChainsAll')
                          : t('wallet.receiveSupportedChainsMatches')}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {chainGroups.otherChains.map((chain) => (
                          <span
                            key={chain.networkKey}
                            className="rounded-full border border-base-300 px-3 py-2 text-sm text-base-content/80"
                          >
                            {chain.name}
                            {selectedOption.sharedAddress ? (
                              <span className="ml-1 text-base-content/45">
                                {t('wallet.receiveSupportedChainsSameAddress')}
                              </span>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="rounded-[1.75rem] border border-amber-200 bg-amber-50/80 p-4 text-amber-950">
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

            {onOpenAgentChat ? (
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[1.75rem] border border-dashed border-base-300 bg-base-100 px-4 py-4 text-left transition hover:bg-base-200"
                onClick={handleButtonClick(() => {
                  onOpenAgentChat(receiveAgentRequest);
                })}
              >
                <div className="flex items-center gap-3">
                  <CircleHelp size={18} className="text-primary" aria-hidden />
                  <span className="text-sm font-medium text-base-content">
                    {t('wallet.receiveAddressGuideOptionTitle')}
                  </span>
                </div>
                <span className="text-sm text-base-content/60">{t('wallet.receiveAddressGuideOptionBody')}</span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </ModalContentScaffold>
  );
}
