import { useMemo, useState, type MouseEvent } from 'react';
import { ArrowDownToLine, CircleHelp, Copy, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import encodeQR from 'qr';
import type { AgentChatOpenRequest } from '../../agent/types';
import { AssetListItem } from '../AssetListItem';
import { ModalContentScaffold } from './ModalContentScaffold';

type ReceiveCryptoContentProps = {
  walletAddress: string;
  chainAccounts?: Array<{
    networkKey: string;
    chainId: number | null;
    protocol?: 'evm' | 'svm' | 'tvm' | 'btc';
    address: string;
  }>;
  supportedChains: Array<{
    networkKey: string;
    chainId: number | null;
    name: string;
    symbol: string;
    marketChain?: string;
    protocol?: 'evm' | 'svm' | 'tvm' | 'btc';
  }>;
  onBack: () => void;
  onCopyAddress: (address: string) => void;
  onClose: () => void;
  onOpenAgentChat?: (request?: AgentChatOpenRequest) => void;
  footerVisible?: boolean;
  stageClassName?: string;
};

type ReceiveAddressType = 'svm' | 'evm' | 'tvm' | 'btc';

const evmChainIcons = [
  { src: '/eth.svg' },
  { src: '/base.svg' },
  { src: '/bnb.svg' },
  { src: '/pol.jpeg' },
] as const;

function getProtocolIconPath(protocol: ReceiveAddressType): string {
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

function joinChainNames(chains: ReceiveCryptoContentProps['supportedChains'], protocol?: ReceiveAddressType): string {
  return chains
    .filter((chain) => !protocol || chain.protocol === protocol)
    .map((chain) => chain.name.trim())
    .filter(Boolean)
    .join(', ');
}

function ReceiveProtocolIcon({ protocol, alt }: { protocol: ReceiveAddressType; alt: string }) {
  if (protocol === 'evm') {
    return (
      <div
        role="img"
        aria-label={alt}
        className="grid h-11 w-11 grid-cols-2 gap-0.5 rounded-lg border border-base-300 bg-base-200 p-1"
      >
        {evmChainIcons.map((icon) => (
          <span
            key={icon.src}
            className="flex h-full w-full items-center justify-center overflow-hidden rounded-sm bg-white"
          >
            <img src={icon.src} alt="" aria-hidden className="h-3 w-3 object-contain" loading="lazy" />
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
        'flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg p-1.5',
        protocol === 'btc'
          ? 'border border-[#F7931A] bg-[#F7931A]'
          : protocol === 'tvm'
            ? 'border border-[#FF060A] bg-[#FF060A]'
            : 'border border-base-300 bg-base-200',
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
  const [selectedAddressType, setSelectedAddressType] = useState<ReceiveAddressType | null>(null);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  const receiveOptions = useMemo(() => {
    const evmChains = supportedChains.filter((chain) => chain.protocol === 'evm');
    const tronChains = supportedChains.filter((chain) => chain.protocol === 'tvm');
    const solanaChains = supportedChains.filter((chain) => chain.protocol === 'svm');
    const bitcoinChains = supportedChains.filter((chain) => chain.protocol === 'btc');
    const evmNetworkLabel =
      evmChains.map((chain) => chain.name).join(' / ') || t('wallet.receiveAddressNetworkFallback', { network: 'EVM' });
    const svmAddress = chainAccounts.find((item) => item.protocol === 'svm')?.address?.trim() || '';
    const tronAddress = chainAccounts.find((item) => item.protocol === 'tvm')?.address?.trim() || '';
    const evmAddress = chainAccounts.find((item) => (item.protocol ?? 'evm') === 'evm')?.address?.trim() || walletAddress;
    const bitcoinAddress = chainAccounts.find((item) => item.protocol === 'btc')?.address?.trim() || '';

    return [
      {
        id: 'evm' as const,
        title: t('wallet.receiveAddressTypeEvm'),
        address: evmAddress,
        addressLabel: t('wallet.receiveAddressTypeEvmLabel'),
        networkLabel: evmNetworkLabel,
        helperText: t('wallet.receiveAddressSharedEvmShortNotice'),
      },
      {
        id: 'tvm' as const,
        title: t('wallet.receiveAddressTypeTron'),
        address: tronAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeTron') }),
        networkLabel:
          tronChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Tron' }),
      },
      {
        id: 'svm' as const,
        title: t('wallet.receiveAddressTypeSolana'),
        address: svmAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeSolana') }),
        networkLabel:
          solanaChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Solana' }),
      },
      {
        id: 'btc' as const,
        title: t('wallet.receiveAddressTypeBitcoin'),
        address: bitcoinAddress,
        addressLabel: t('wallet.receiveAddressOptionLabel', { chain: t('wallet.receiveAddressTypeBitcoin') }),
        networkLabel:
          bitcoinChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Bitcoin' }),
      },
    ].filter((option) => option.address);
  }, [chainAccounts, supportedChains, t, walletAddress]);

  const selectedOption = useMemo(
    () => receiveOptions.find((option) => option.id === selectedAddressType) ?? null,
    [receiveOptions, selectedAddressType],
  );

  const displayAddress = useMemo(() => {
    if (selectedAddressType) {
      const matched = chainAccounts.find((item) => (item.protocol ?? 'evm') === selectedAddressType)?.address?.trim();
      if (matched) return matched;
    }
    return walletAddress;
  }, [chainAccounts, selectedAddressType, walletAddress]);

  const qrCodeSvgMarkup = useMemo(() => {
    if (!displayAddress) return '';

    return encodeQR(displayAddress, 'svg', {
      border: 2,
      scale: 8,
    });
  }, [displayAddress]);

  const step: 'type' | 'address' = selectedAddressType ? 'address' : 'type';

  function handleBack() {
    if (selectedAddressType) {
      setSelectedAddressType(null);
      return;
    }
    onBack();
  }

  const receiveAgentRequest = useMemo<AgentChatOpenRequest>(() => {
    const evmAddress = chainAccounts.find((item) => (item.protocol ?? 'evm') === 'evm')?.address?.trim() || walletAddress.trim();
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

  return (
    <ModalContentScaffold
      title={step === 'type' ? t('wallet.receiveSelectAddressTypeTitle') : t('wallet.receiveTransferToAddressTitle')}
      bodyClassName={step === 'type' ? 'justify-center' : 'justify-start'}
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
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="w-full cursor-pointer text-left"
            onClick={handleButtonClick(() => {
              onOpenAgentChat?.(receiveAgentRequest);
            })}
          >
            <AssetListItem
              className="rounded-2xl bg-base-200 py-3"
              leftIcon={
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/12 text-primary">
                  <CircleHelp size={22} aria-hidden />
                </div>
              }
              leftPrimary={t('wallet.receiveAddressGuideOptionTitle')}
              leftPrimaryClassName="text-lg"
              leftSecondary={t('wallet.receiveAddressGuideOptionBody')}
              leftSecondaryClassName="text-sm !text-base-content/70"
            />
          </button>
          {receiveOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className="w-full cursor-pointer text-left"
              onClick={handleButtonClick(() => setSelectedAddressType(option.id))}
            >
              <AssetListItem
                className="py-3"
                leftIcon={<ReceiveProtocolIcon protocol={option.id} alt={option.title} />}
                leftPrimary={option.addressLabel}
                leftPrimaryClassName="text-lg"
                leftSecondary={option.address ? truncateAddress(option.address, 8, 8) : t('wallet.addressUnavailable')}
                leftSecondaryClassName="text-base"
                leftTertiary={option.helperText}
              />
            </button>
          ))}
        </div>
      ) : selectedOption ? (
        <div className="min-h-0 overflow-y-auto">
          <div className="flex flex-col gap-4 py-2">
            <div className="rounded-3xl border border-base-300 bg-base-200 p-4">
              {displayAddress ? (
                <div
                  aria-label={`${selectedOption.title} QR`}
                  className="mx-auto h-56 w-56 rounded-2xl border border-base-300 bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: qrCodeSvgMarkup }}
                />
              ) : null}
              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-base-100 px-4 py-3">
                <div className="min-w-0">
                  <p className="m-0 text-xs text-base-content/60">{t('wallet.receiveAddressLabel')}</p>
                  <p className="m-0 truncate text-sm font-medium">
                    {displayAddress ? truncateAddress(displayAddress) : t('wallet.addressUnavailable')}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-circle btn-ghost h-10 min-h-0 w-10"
                  aria-label={t('wallet.copy')}
                  onClick={handleButtonClick(() => onCopyAddress(displayAddress))}
                >
                  <Copy size={18} aria-hidden />
                </button>
              </div>
            </div>

            <div className="border-t border-base-300 pt-4">
              <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm text-base-content/80">
                <li className="flex items-start gap-3">
                  <Info size={18} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden />
                  <span>
                    {t('wallet.receiveAddressTypeNotice', {
                      addressType: selectedOption.title,
                      network: selectedOption.networkLabel,
                    })}
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <ArrowDownToLine size={18} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden />
                  <span>{t('wallet.receiveAddressConfirmationNotice')}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </ModalContentScaffold>
  );
}
