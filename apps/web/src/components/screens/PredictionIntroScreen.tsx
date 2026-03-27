import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { activatePredictionAccount, getPredictionAccount } from '../../api';
import { useToast } from '../../contexts/ToastContext';

type PredictionIntroScreenProps = {
  onBack: () => void;
  onOpenPredictionHub: () => void;
};

export function PredictionIntroScreen({ onBack, onOpenPredictionHub }: PredictionIntroScreenProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showError, showSuccess } = useToast();
  const [isActivating, setIsActivating] = useState(false);

  const { data: predictionAccount } = useQuery({
    queryKey: ['prediction-account', 'eoa'],
    queryFn: () => getPredictionAccount({ signatureType: 'eoa' }),
    staleTime: 15_000,
    refetchInterval: 20_000,
  });

  const isActivated = predictionAccount?.activationState === 'active';

  async function handlePrimaryAction(): Promise<void> {
    if (isActivated) {
      onOpenPredictionHub();
      return;
    }
    if (isActivating) return;

    setIsActivating(true);
    try {
      await activatePredictionAccount({ signatureType: 'eoa' });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['prediction-account', 'eoa'] }),
        queryClient.invalidateQueries({ queryKey: ['wallet-portfolio'] }),
      ]);
      showSuccess(t('wallet.predictionActivationSuccess'));
      onOpenPredictionHub();
    } catch {
      showError(t('wallet.predictionActivationFailed'));
    } finally {
      setIsActivating(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-105 flex-col gap-5 p-5 pb-40">
      <header className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className="btn btn-sm btn-ghost border-0 px-2"
          onClick={onBack}
          aria-label={t('wallet.back')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </header>

      <section className="py-2">
        <h1 className="m-0 text-3xl font-bold tracking-tight">{t('wallet.predictionIntroTitle')}</h1>
        <p className="m-0 mt-3 max-w-xl text-sm leading-7 text-base-content/70">
          {t('wallet.predictionIntroSubtitle')}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="rounded-3xl border border-base-300 bg-base-100 p-4">
          <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.predictionFeatureConvictionTitle')}</p>
          <p className="m-0 mt-2 text-sm leading-7 text-base-content/65">{t('wallet.predictionFeatureConvictionBody')}</p>
        </div>
        <div className="rounded-3xl border border-base-300 bg-base-100 p-4">
          <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.predictionFeatureDiscoveryTitle')}</p>
          <p className="m-0 mt-2 text-sm leading-7 text-base-content/65">{t('wallet.predictionFeatureDiscoveryBody')}</p>
        </div>
      </section>

      <div className="mt-auto flex flex-col gap-3">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={() => void handlePrimaryAction()}
          disabled={isActivating}
        >
          {isActivating ? <span className="loading loading-spinner loading-sm" /> : null}
          {isActivated ? t('wallet.predictionOpenHub') : t('wallet.predictionActivate')}
        </button>
      </div>
    </section>
  );
}
