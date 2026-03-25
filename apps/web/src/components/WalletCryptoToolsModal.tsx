import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCoinDetail, searchMarketTokens, type AppConfigResponse, type MarketSearchResult } from '../api';
import { useToast } from '../contexts/ToastContext';
import { buildChainAssetId } from '../utils/assetIdentity';
import { normalizeContractForChain, normalizeMarketChain } from '../utils/chainIdentity';
import type { WalletAddedAssetInput, WalletCryptoFilterState } from '../utils/walletTrackedAssets';
import { CachedIconImage } from './CachedIconImage';
import { Modal } from './modals/Modal';

type WalletCryptoToolsModalProps = {
  visible: boolean;
  mode: 'filter' | 'add' | null;
  supportedChains: AppConfigResponse['supportedChains'];
  currentFilterState: WalletCryptoFilterState;
  existingAssetKeys: Set<string>;
  onClose: () => void;
  onFilterChange: (nextState: WalletCryptoFilterState) => void;
  onAddAsset: (input: WalletAddedAssetInput) => void;
};

function formatPct(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${numeric.toFixed(2)}%`;
}

function pctClassName(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return 'text-base-content/55';
  const numeric = Number(value);
  if (numeric > 0) return 'text-success';
  if (numeric < 0) return 'text-error';
  return 'text-base-content/70';
}

function getAssetKey(chain: string | null | undefined, contract: string | null | undefined): string {
  return buildChainAssetId(chain, contract).trim();
}

export function WalletCryptoToolsModal({
  visible,
  mode,
  supportedChains,
  currentFilterState,
  existingAssetKeys,
  onClose,
  onFilterChange,
  onAddAsset,
}: WalletCryptoToolsModalProps) {
  const { t, i18n } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [addMode, setAddMode] = useState<'search' | 'manual'>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedNetworkKey, setSelectedNetworkKey] = useState('');
  const [manualContract, setManualContract] = useState('');
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supportedSpotChains = useMemo(
    () => supportedChains.filter((item) => item.protocol === 'evm' || item.protocol === 'svm' || item.protocol === 'tvm' || item.protocol === 'btc'),
    [supportedChains],
  );

  const supportedChainByMarketChain = useMemo(
    () => new Map(supportedSpotChains.map((item) => [normalizeMarketChain(item.marketChain), item] as const)),
    [supportedSpotChains],
  );

  const filteredSearchResults = useMemo(
    () =>
      results.filter((item) => {
        if (item.marketType !== 'spot') return false;
        const normalizedChain = normalizeMarketChain(item.chain);
        return Boolean(normalizedChain && supportedChainByMarketChain.has(normalizedChain));
      }),
    [results, supportedChainByMarketChain],
  );

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setResults([]);
      setIsSearching(false);
      setAddMode('search');
      setManualContract('');
      return;
    }

    setSelectedNetworkKey((current) => current || supportedSpotChains[0]?.networkKey || '');
    if (mode === 'add') {
      window.setTimeout(() => searchInputRef.current?.focus(), 80);
    }
  }, [mode, supportedSpotChains, visible]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  async function performSearch(nextQuery: string): Promise<void> {
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    try {
      const items = await searchMarketTokens(trimmed, 20);
      setResults(items);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  function handleQueryChange(nextValue: string): void {
    setQuery(nextValue);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void performSearch(nextValue);
    }, 300);
  }

  function handleAddFromSearch(item: MarketSearchResult): void {
    if (!item.chain) {
      showError(t('wallet.cryptoManageUnsupportedNetwork'));
      return;
    }

    const chain = normalizeMarketChain(item.chain);
    const chainConfig = supportedChainByMarketChain.get(chain);
    if (!chainConfig) {
      showError(t('wallet.cryptoManageUnsupportedNetwork'));
      return;
    }

    const assetKey = getAssetKey(chain, item.contract ?? '');
    if (existingAssetKeys.has(assetKey)) {
      showSuccess(t('wallet.cryptoManageAlreadyAdded'));
      return;
    }

    onAddAsset({
      chain,
      contract: item.contract ?? '',
      networkKey: chainConfig.networkKey,
      symbol: item.symbol,
      name: item.name,
      image: item.image,
      assetId: item.asset_id ?? null,
    });
    showSuccess(t('wallet.cryptoManageAddSuccess', { symbol: item.symbol || t('wallet.token') }));
    onClose();
  }

  async function handleManualAdd(): Promise<void> {
    const selectedChain = supportedSpotChains.find((item) => item.networkKey === selectedNetworkKey) ?? null;
    if (!selectedChain) {
      showError(t('wallet.cryptoManageUnsupportedNetwork'));
      return;
    }

    const normalizedChain = normalizeMarketChain(selectedChain.marketChain);
    const normalizedContract = normalizeContractForChain(normalizedChain, manualContract);
    if (!manualContract.trim() || normalizedContract === 'native') {
      showError(t('wallet.cryptoManageContractRequired'));
      return;
    }

    const assetKey = getAssetKey(normalizedChain, normalizedContract);
    if (existingAssetKeys.has(assetKey)) {
      showSuccess(t('wallet.cryptoManageAlreadyAdded'));
      return;
    }

    setIsSubmittingManual(true);
    try {
      const detail = await getCoinDetail(normalizedChain, normalizedContract);
      onAddAsset({
        chain: normalizedChain,
        contract: detail.contract || normalizedContract,
        networkKey: selectedChain.networkKey,
        symbol: detail.symbol,
        name: detail.name,
        image: detail.image,
        assetId: detail.asset_id,
      });
      showSuccess(t('wallet.cryptoManageAddSuccess', { symbol: detail.symbol || t('wallet.token') }));
      onClose();
    } catch {
      showError(t('wallet.cryptoManageTokenNotFound'));
    } finally {
      setIsSubmittingManual(false);
    }
  }

  if (!visible || !mode) return null;

  return (
    <Modal visible originRect={null} onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h3 className="m-0 text-lg font-semibold">
              {mode === 'filter' ? t('wallet.cryptoManageFilterTitle') : t('wallet.cryptoManageAddTitle')}
            </h3>
            <p className="m-0 mt-1 text-sm text-base-content/60">
              {mode === 'filter' ? t('wallet.cryptoManageFilterHint') : t('wallet.cryptoManageAddHint')}
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </header>

        {mode === 'filter' ? (
          <div className="mt-6 flex flex-1 flex-col gap-5 overflow-y-auto">
            <section className="rounded-3xl border border-base-300 bg-base-100 p-4">
              <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.cryptoManageNetwork')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`btn btn-sm border-0 ${currentFilterState.networkKey ? 'btn-ghost' : 'btn-primary'}`}
                  onClick={() => onFilterChange({ ...currentFilterState, networkKey: '' })}
                >
                  {t('wallet.cryptoManageAllNetworks')}
                </button>
                {supportedSpotChains.map((chain) => (
                  <button
                    key={chain.networkKey}
                    type="button"
                    className={`btn btn-sm border-0 ${currentFilterState.networkKey === chain.networkKey ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => onFilterChange({ ...currentFilterState, networkKey: chain.networkKey })}
                  >
                    {chain.name}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-3xl border border-base-300 bg-base-100 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.cryptoManageHideSmall')}</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">
                    {t('wallet.cryptoManageHideSmallHint', { amount: '$1' })}
                  </p>
                </div>
                <input
                  type="checkbox"
                  className="toggle toggle-primary mt-1"
                  checked={currentFilterState.hideSmallBalances}
                  onChange={(event) => onFilterChange({ ...currentFilterState, hideSmallBalances: event.target.checked })}
                />
              </div>
            </section>
          </div>
        ) : (
          <div className="mt-6 flex min-h-0 flex-1 flex-col">
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn btn-sm flex-1 border-0 ${addMode === 'search' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAddMode('search')}
              >
                {t('wallet.cryptoManageSearchMode')}
              </button>
              <button
                type="button"
                className={`btn btn-sm flex-1 border-0 ${addMode === 'manual' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setAddMode('manual')}
              >
                {t('wallet.cryptoManageManualMode')}
              </button>
            </div>

            {addMode === 'search' ? (
              <>
                <div className="relative mt-4">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-base-content/50"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="input input-bordered w-full pl-9 text-sm"
                    placeholder={t('wallet.cryptoManageSearchPlaceholder')}
                    value={query}
                    onChange={(event) => handleQueryChange(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <p className="m-0 mt-3 text-sm text-base-content/55">{t('wallet.cryptoManageSearchHint')}</p>

                <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                  {isSearching ? (
                    <div className="flex items-center justify-center py-8">
                      <span className="loading loading-spinner loading-md" />
                    </div>
                  ) : !query.trim() ? (
                    <p className="py-8 text-center text-sm text-base-content/50">{t('wallet.cryptoManageSearchEmpty')}</p>
                  ) : filteredSearchResults.length === 0 ? (
                    <p className="py-8 text-center text-sm text-base-content/60">{t('wallet.cryptoManageSearchNoResults')}</p>
                  ) : (
                    <div className="overflow-hidden rounded-3xl border border-base-300 bg-base-100">
                      {filteredSearchResults.map((item) => {
                        const assetKey = getAssetKey(item.chain, item.contract);
                        const isAdded = existingAssetKeys.has(assetKey);
                        const changeClass = pctClassName(item.change24h);
                        const fallback = (
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/75">
                            {item.symbol ? item.symbol[0].toUpperCase() : '?'}
                          </div>
                        );

                        return (
                          <button
                            key={item.id}
                            type="button"
                            className="flex w-full items-center justify-between gap-3 border-b border-base-300 px-4 py-3 text-left transition-colors hover:bg-base-200/60 last:border-b-0"
                            onClick={() => handleAddFromSearch(item)}
                            disabled={isAdded}
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              {item.image ? (
                                <CachedIconImage
                                  src={item.image}
                                  alt={item.symbol}
                                  className="h-10 w-10 rounded-full bg-base-300 object-cover"
                                  loading="lazy"
                                  fallback={fallback}
                                />
                              ) : fallback}
                              <div className="min-w-0">
                                <p className="m-0 truncate text-sm font-semibold">{item.symbol}</p>
                                <p className="m-0 mt-0.5 truncate text-xs text-base-content/55">{item.name}</p>
                                <p className="m-0 mt-1 text-xs text-base-content/45">
                                  {supportedChainByMarketChain.get(normalizeMarketChain(item.chain))?.name ?? normalizeMarketChain(item.chain).toUpperCase()}
                                </p>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="m-0 text-sm text-base-content/65">
                                {item.currentPrice != null ? Number(item.currentPrice).toLocaleString(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }) : '--'}
                              </p>
                              <p className={`m-0 mt-0.5 text-xs font-semibold ${changeClass}`}>{formatPct(item.change24h)}</p>
                              <p className="m-0 mt-1 text-xs font-medium text-primary">
                                {isAdded ? t('wallet.cryptoManageAdded') : t('wallet.cryptoManageAdd')}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="mt-4 flex flex-1 flex-col gap-4">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-base-content" htmlFor="wallet-crypto-network">
                    {t('wallet.cryptoManageNetwork')}
                  </label>
                  <select
                    id="wallet-crypto-network"
                    className="select select-bordered w-full"
                    value={selectedNetworkKey}
                    onChange={(event) => setSelectedNetworkKey(event.target.value)}
                  >
                    {supportedSpotChains.map((chain) => (
                      <option key={chain.networkKey} value={chain.networkKey}>
                        {chain.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-base-content" htmlFor="wallet-crypto-contract">
                    {t('wallet.cryptoManageContractLabel')}
                  </label>
                  <input
                    id="wallet-crypto-contract"
                    type="text"
                    className="input input-bordered w-full"
                    placeholder={t('wallet.cryptoManageContractPlaceholder')}
                    value={manualContract}
                    onChange={(event) => setManualContract(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="m-0 mt-2 text-sm text-base-content/55">{t('wallet.cryptoManageManualHint')}</p>
                </div>

                <div className="mt-auto pt-2">
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    onClick={() => void handleManualAdd()}
                    disabled={isSubmittingManual}
                  >
                    {isSubmittingManual ? <span className="loading loading-spinner loading-xs" /> : null}
                    {t('wallet.cryptoManageAdd')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
