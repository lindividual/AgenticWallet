import type { MouseEvent } from 'react';
import { ArrowDownToLine, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ModalContentScaffold } from './ModalContentScaffold';

type TopUpContentProps = {
  active: boolean;
  onOpenReceive: () => void;
  onOpenTrade: (mode: 'buy' | 'stableSwap') => void;
  onClose: () => void;
  footerVisible?: boolean;
  stageClassName?: string;
};

export function TopUpContent({
  active,
  onOpenReceive,
  onOpenTrade,
  onClose,
  footerVisible = true,
  stageClassName,
}: TopUpContentProps) {
  const { t } = useTranslation();

  function handleButtonClick(action: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      action();
    };
  }

  return (
    <ModalContentScaffold
      title={t('wallet.topUpTitle')}
      bodyClassName="justify-center"
      contentClassName="mt-16 flex flex-col gap-10"
      stageClassName={stageClassName}
      footerVisible={footerVisible}
      onClose={handleButtonClick(onClose)}
      closeAriaLabel={t('common.close')}
    >
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
    </ModalContentScaffold>
  );
}
