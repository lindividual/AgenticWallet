import { useMemo, useState, type MouseEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, Copy, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import encodeQR from 'qr';
import { AssetListItem } from '../AssetListItem';

type ReceiveCryptoContentProps = {
  walletAddress: string;
  chainAccounts?: Array<{
    chainId: number;
    protocol?: 'evm' | 'svm';
    address: string;
  }>;
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
    marketChain?: string;
    protocol?: 'evm' | 'svm';
  }>;
  onBack: () => void;
  onCopyAddress: (address: string) => void;
  onClose: () => void;
};

type ReceiveAddressType = 'svm' | 'evm';

function getProtocolIconPath(protocol: ReceiveAddressType): string {
  return protocol === 'svm' ? '/sol.svg' : '/eth.svg';
}

function truncateAddress(address: string, head = 6, tail = 6): string {
  if (!address) return '';
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}...${address.slice(-tail)}`;
}

export function ReceiveCryptoContent({
  walletAddress,
  chainAccounts = [],
  supportedChains,
  onBack,
  onCopyAddress,
  onClose,
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
    const evmChains = supportedChains.filter((chain) => chain.protocol !== 'svm');
    const solanaChains = supportedChains.filter((chain) => chain.protocol === 'svm');
    const svmAddress = chainAccounts.find((item) => item.protocol === 'svm')?.address?.trim() || walletAddress;
    const evmAddress = chainAccounts.find((item) => (item.protocol ?? 'evm') === 'evm')?.address?.trim() || walletAddress;

    return [
      {
        id: 'svm' as const,
        title: t('wallet.receiveAddressTypeSolana'),
        address: svmAddress,
        subtitle:
          solanaChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'Solana' }),
      },
      {
        id: 'evm' as const,
        title: t('wallet.receiveAddressTypeEvm'),
        address: evmAddress,
        subtitle:
          evmChains.map((chain) => chain.name).join(' / ') ||
          t('wallet.receiveAddressNetworkFallback', { network: 'EVM' }),
      },
    ];
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

  return (
    <div className="flex min-h-full flex-col">
      <div className={`flex min-h-0 flex-col ${step === 'type' ? 'justify-center' : ''}`}>
        <header>
          <div className="relative h-11 overflow-hidden">
            <h2
              className={`absolute inset-0 m-0 text-4xl font-bold tracking-tight transition-all duration-300 ${
                step === 'type' ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-4 opacity-0'
              }`}
            >
              {t('wallet.receiveSelectAddressTypeTitle')}
            </h2>
            <h2
              className={`absolute inset-0 m-0 text-4xl font-bold tracking-tight transition-all duration-300 ${
                step === 'address' ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-4 opacity-0'
              }`}
            >
              {t('wallet.receiveTransferToAddressTitle')}
            </h2>
          </div>
          <div
            className={`overflow-hidden transition-all duration-300 ${
              step === 'type' ? 'mt-4 max-h-20 opacity-100' : 'mt-0 max-h-0 opacity-0'
            }`}
            aria-hidden={step !== 'type'}
          >
            <div className="space-y-1">
              <p className="m-0 text-sm font-semibold text-base-content/80">{t('wallet.receiveAddressTypeHelpTitle')}</p>
              <p className="m-0 text-sm leading-6 text-base-content/60">{t('wallet.receiveAddressTypeHelpBody')}</p>
            </div>
          </div>
        </header>

        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          {step === 'type' ? (
            <div className="flex flex-col gap-2 transition-all duration-300">
              {receiveOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="w-full cursor-pointer text-left"
                  onClick={handleButtonClick(() => setSelectedAddressType(option.id))}
                >
                  <AssetListItem
                    className="py-3"
                    leftIcon={
                      <img
                        src={getProtocolIconPath(option.id)}
                        alt={option.title}
                        className="h-10 w-10 rounded-full bg-base-300 object-cover"
                        loading="lazy"
                      />
                    }
                    leftPrimary={option.subtitle}
                    leftPrimaryClassName="text-lg"
                    leftSecondary={option.address ? truncateAddress(option.address, 8, 8) : t('wallet.addressUnavailable')}
                    leftSecondaryClassName="text-base"
                  />
                </button>
              ))}
            </div>
          ) : selectedOption ? (
            <div className="min-h-0 overflow-y-auto transition-all duration-300">
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
                          network: selectedOption.subtitle,
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
        </div>
      </div>

      <div className="relative mt-auto flex items-center justify-center pt-6">
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
    </div>
  );
}
