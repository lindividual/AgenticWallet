import { useEffect, useState, type MouseEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, X, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TopUpContentProps = {
  active: boolean;
  onOpenReceive: () => void;
  onClose: () => void;
};

export function TopUpContent({ active, onOpenReceive, onClose }: TopUpContentProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<'menu' | 'buy'>('menu');

  useEffect(() => {
    if (active) {
      setView('menu');
    }
  }, [active]);

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col justify-center">
        {view === 'menu' && (
          <>
            <header>
              <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.topUpTitle')}</h2>
            </header>

            <div className="mt-16 flex flex-col gap-10">
              <button
                type="button"
                className="btn btn-ghost h-12 justify-start px-0 text-left text-2xl font-semibold gap-6"
                onClick={handleButtonClick(onOpenReceive)}
              >
                <ArrowDownToLine size={30} aria-hidden />
                <span>{t('wallet.receiveCrypto')}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost h-12 justify-start px-0 text-left text-2xl font-semibold gap-6"
                onClick={handleButtonClick(() => setView('buy'))}
              >
                <CreditCard size={30} aria-hidden />
                <span>{t('wallet.buyCrypto')}</span>
              </button>
            </div>
          </>
        )}

        {view === 'buy' && (
          <>
            <header>
              <h2 className="m-0 text-4xl font-bold tracking-tight">{t('wallet.buyCrypto')}</h2>
            </header>

            <div className="mt-16 border border-base-300 bg-base-100 p-5">
              <p className="m-0 text-2xl font-medium">{t('wallet.buyComingSoon')}</p>
            </div>
          </>
        )}
      </div>

      {view === 'buy' ? (
        <div className="mt-auto flex items-center justify-between pt-6">
          <button
            type="button"
            className="btn btn-ghost h-12 w-12 p-0"
            onClick={handleButtonClick(() => setView('menu'))}
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
      ) : (
        <div className="mt-auto flex items-center justify-center pt-6">
          <button
            type="button"
            className="btn btn-ghost h-12 w-12 p-0"
            aria-label={t('common.close')}
            onClick={handleButtonClick(onClose)}
          >
            <X size={26} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
