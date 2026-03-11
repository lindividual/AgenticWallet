import type { MouseEvent } from 'react';
import { ArrowDownToLine, CreditCard, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TopUpContentProps = {
  active: boolean;
  onOpenReceive: () => void;
  onOpenTrade: (mode: 'buy' | 'stableSwap') => void;
  onClose: () => void;
};

export function TopUpContent({ active, onOpenReceive, onOpenTrade, onClose }: TopUpContentProps) {
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
          <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.topUpTitle')}</h2>
        </header>

        <div className="mt-16 flex flex-col gap-10">
          <button
            type="button"
            className="btn btn-ghost h-12 justify-start gap-6 border-transparent px-0 text-left text-2xl font-semibold shadow-none hover:border-transparent hover:bg-transparent hover:shadow-none focus:border-transparent focus:bg-transparent active:border-transparent active:bg-transparent"
            onClick={handleButtonClick(onOpenReceive)}
            disabled={!active}
          >
            <ArrowDownToLine size={30} aria-hidden />
            <span>{t('wallet.receiveCrypto')}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost h-12 justify-start gap-6 border-transparent px-0 text-left text-2xl font-semibold shadow-none hover:border-transparent hover:bg-transparent hover:shadow-none focus:border-transparent focus:bg-transparent active:border-transparent active:bg-transparent"
            onClick={handleButtonClick(() => onOpenTrade('buy'))}
            disabled={!active}
          >
            <CreditCard size={30} aria-hidden />
            <span>{t('wallet.buyCrypto')}</span>
          </button>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-center pt-6">
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
