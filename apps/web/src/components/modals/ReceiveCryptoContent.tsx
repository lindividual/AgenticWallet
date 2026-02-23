import type { MouseEvent } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ReceiveCryptoContentProps = {
  walletAddress: string;
  supportedChains: Array<{
    chainId: number;
    name: string;
    symbol: string;
  }>;
  defaultReceiveTokens: string[];
  onBack: () => void;
  onCopyAddress: () => void;
  onClose: () => void;
};

export function ReceiveCryptoContent({
  walletAddress,
  supportedChains,
  defaultReceiveTokens,
  onBack,
  onCopyAddress,
  onClose,
}: ReceiveCryptoContentProps) {
  const { t } = useTranslation();

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col justify-center">
        <header>
          <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.receiveCryptoTitle')}</h2>
        </header>

        <div className="mt-16 flex flex-col gap-4 border border-base-300 bg-base-100 p-5">
          <p className="m-0 text-xl font-medium break-all">{walletAddress || t('wallet.addressUnavailable')}</p>

          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-base-content/70">{t('wallet.supportedChains')}</p>
            <div className="flex flex-wrap gap-2">
              {supportedChains.map((chain) => (
                <span key={chain.chainId} className="badge badge-outline h-7 px-3">
                  {chain.name}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-base-content/70">{t('wallet.defaultReceiveTokens')}</p>
            <div className="flex flex-wrap gap-2">
              {defaultReceiveTokens.map((token) => (
                <span key={token} className="badge badge-primary h-7 px-3">
                  {token}
                </span>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary h-12 w-fit px-6 text-base font-semibold"
            onClick={handleButtonClick(onCopyAddress)}
          >
            {t('wallet.copy')}
          </button>
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
