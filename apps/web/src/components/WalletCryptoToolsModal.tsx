import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCoinDetail, searchWalletAddableTokens, type AppConfigResponse, type MarketSearchResult } from '../api';
import { useToast } from '../contexts/ToastContext';
import { buildChainAssetId } from '../utils/assetIdentity';
import { normalizeContractForChain, normalizeMarketChain } from '../utils/chainIdentity';
import type { WalletAddedAsset, WalletAddedAssetInput, WalletCryptoFilterState } from '../utils/walletTrackedAssets';
import { CachedIconImage } from './CachedIconImage';
import { Modal } from './modals/Modal';

type WalletCryptoToolsModalProps = {
  visible: boolean;
  mode: 'filter' | 'add' | null;
  supportedChains: AppConfigResponse['supportedChains'];
  currentFilterState: WalletCryptoFilterState;
  addedAssets: WalletAddedAsset[];
  existingAssetKeys: Set<string>;
  onClose: () => void;
  onFilterChange: (nextState: WalletCryptoFilterState) => void;
  onAddAsset: (input: WalletAddedAssetInput) => void;
  onRemoveAsset: (chain: string, contract: string) => void;
};

function getAssetKey(chain: string | null | undefined, contract: string | null | undefined): string {
  return buildChainAssetId(chain, contract).trim();
}

function truncateMiddle(value: string, leading = 6, trailing = 4): string {
  const normalized = value.trim();
  if (!normalized) return '--';
  if (normalized.length <= leading + trailing + 3) return normalized;
  return `${normalized.slice(0, leading)}...${normalized.slice(-trailing)}`;
}

function getTokenFallback(symbol: string | null | undefined, name: string | null | undefined) {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-base-300 text-sm font-semibold text-base-content/75">
      {(symbol || name || '?')[0]?.toUpperCase() ?? '?'}
    </div>
  );
}

export function WalletCryptoToolsModal({
  visible,
  mode,
  supportedChains,
  currentFilterState,
  addedAssets,
  existingAssetKeys,
  onClose,
  onFilterChange,
  onAddAsset,
  onRemoveAsset,
}: WalletCryptoToolsModalProps) {
  const { t } = useTranslation();
  const { showError, showSuccess } = useToast();
  const [filterPanel, setFilterPanel] = useState<'main' | 'chain'>('main');
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
        if (!normalizedChain || !supportedChainByMarketChain.has(normalizedChain)) return false;
        return !existingAssetKeys.has(getAssetKey(normalizedChain, item.contract ?? ''));
      }),
    [existingAssetKeys, results, supportedChainByMarketChain],
  );

  useEffect(() => {
    if (!visible) {
      setFilterPanel('main');
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
      const items = await searchWalletAddableTokens(trimmed, 20);
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

  function handleRemoveAddedAsset(asset: WalletAddedAsset): void {
    onRemoveAsset(asset.chain, asset.contract);
    showSuccess(t('wallet.cryptoManageRemoveSuccess', { symbol: asset.symbol || t('wallet.token') }));
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

  const renderTokenRow = ({
    key,
    symbol,
    name,
    image,
    chainLabel,
    contract,
    buttonLabel,
    buttonClassName,
    onClick,
    disabled = false,
  }: {
    key: string;
    symbol: string | null | undefined;
    name: string | null | undefined;
    image: string | null | undefined;
    chainLabel: string;
    contract?: string | null | undefined;
    buttonLabel: string;
    buttonClassName: string;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <div
      key={key}
      className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        {image ? (
          <CachedIconImage
            src={image}
            alt={symbol || name || t('wallet.token')}
            className="h-10 w-10 rounded-full bg-base-300 object-cover"
            loading="lazy"
            fallback={getTokenFallback(symbol, name)}
          />
        ) : getTokenFallback(symbol, name)}
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-semibold text-base-content">
            {symbol || t('wallet.token')}
          </p>
          <p className="m-0 mt-1 text-xs text-base-content/45">
            {chainLabel}
            {contract && contract !== 'native'
              ? ` · ${truncateMiddle(contract, 6, 4)}`
              : ''}
          </p>
        </div>
      </div>

      <button
        type="button"
        className={buttonClassName}
        onClick={onClick}
        disabled={disabled}
      >
        {buttonLabel}
      </button>
    </div>
  );

  const addedAssetsSection = (
    <section className="mt-4 rounded-3xl border border-base-300 bg-base-100 p-4">
      <p className="m-0 text-sm font-semibold text-base-content">
        {t('wallet.cryptoManageAddedSectionTitle')}
      </p>

      {addedAssets.length === 0 ? (
        <p className="m-0 mt-3 text-sm text-base-content/50">
          {t('wallet.cryptoManageAddedSectionEmpty')}
        </p>
      ) : (
        <div className="mt-3 max-h-56 overflow-y-auto">
          <div className="overflow-hidden rounded-2xl border border-base-300">
            {addedAssets.map((asset) => {
              const chainLabel =
                supportedChainByMarketChain.get(normalizeMarketChain(asset.chain))?.name
                ?? asset.networkKey
                ?? asset.chain.toUpperCase();
              return renderTokenRow({
                key: getAssetKey(asset.chain, asset.contract),
                symbol: asset.symbol,
                name: asset.name,
                image: asset.image,
                chainLabel,
                contract: asset.contract,
                buttonLabel: t('trade.remove'),
                buttonClassName: 'btn btn-ghost btn-xs shrink-0 text-error hover:bg-error/10',
                onClick: () => handleRemoveAddedAsset(asset),
              });
            })}
          </div>
        </div>
      )}
    </section>
  );

  return (
    <Modal visible originRect={null} onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {mode === 'filter' && filterPanel === 'chain' ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm -ml-2 mt-0.5 px-2"
                onClick={() => setFilterPanel('main')}
                aria-label={t('wallet.back')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            ) : null}
            <div>
              <h3 className="m-0 text-lg font-semibold">
                {mode === 'filter'
                  ? filterPanel === 'chain'
                    ? t('wallet.cryptoManageChainTitle')
                    : t('wallet.cryptoManageFilterTitle')
                  : t('wallet.cryptoManageAddTitle')}
              </h3>
              <p className="m-0 mt-1 text-sm text-base-content/60">
                {mode === 'filter'
                  ? filterPanel === 'chain'
                    ? t('wallet.cryptoManageChainHint')
                    : t('wallet.cryptoManageFilterHint')
                  : t('wallet.cryptoManageAddHint')}
              </p>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </header>

        {mode === 'filter' ? (
          filterPanel === 'chain' ? (
            <div className="mt-6 flex flex-1 flex-col overflow-y-auto">
              <div className="overflow-hidden rounded-3xl border border-base-300 bg-base-100">
                <button
                  type="button"
                  className={`flex w-full items-center justify-between border-b border-base-300 px-4 py-4 text-left transition-colors hover:bg-base-200/60 ${!currentFilterState.networkKey ? 'text-primary' : ''}`}
                  onClick={() => {
                    onFilterChange({ ...currentFilterState, networkKey: '' });
                    setFilterPanel('main');
                  }}
                >
                  <span className="text-sm font-semibold">{t('wallet.cryptoManageAllChains')}</span>
                  {!currentFilterState.networkKey ? (
                    <span aria-hidden="true">✓</span>
                  ) : null}
                </button>
                {supportedSpotChains.map((chain, index) => {
                  const isActive = currentFilterState.networkKey === chain.networkKey;
                  return (
                    <button
                      key={chain.networkKey}
                      type="button"
                      className={`flex w-full items-center justify-between px-4 py-4 text-left transition-colors hover:bg-base-200/60 ${index < supportedSpotChains.length - 1 ? 'border-b border-base-300' : ''} ${isActive ? 'text-primary' : ''}`}
                      onClick={() => {
                        onFilterChange({ ...currentFilterState, networkKey: chain.networkKey });
                        setFilterPanel('main');
                      }}
                    >
                      <span className="text-sm font-semibold">{chain.name}</span>
                      {isActive ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-1 flex-col gap-4 overflow-y-auto">
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

              <section className="rounded-3xl border border-base-300 bg-base-100 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.cryptoManageHideHighRisk')}</p>
                    <p className="m-0 mt-1 text-sm text-base-content/60">
                      {t('wallet.cryptoManageHideHighRiskHint')}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    className="toggle toggle-primary mt-1"
                    checked={currentFilterState.hideHighRisk}
                    onChange={(event) => onFilterChange({ ...currentFilterState, hideHighRisk: event.target.checked })}
                  />
                </div>
              </section>

              <button
                type="button"
                className="flex items-center justify-between rounded-3xl border border-base-300 bg-base-100 px-4 py-4 text-left transition-colors hover:bg-base-200/60"
                onClick={() => setFilterPanel('chain')}
              >
                <div>
                  <p className="m-0 text-sm font-semibold text-base-content">{t('wallet.cryptoManageChainLabel')}</p>
                  <p className="m-0 mt-1 text-sm text-base-content/60">
                    {currentFilterState.networkKey
                      ? supportedSpotChains.find((chain) => chain.networkKey === currentFilterState.networkKey)?.name ?? currentFilterState.networkKey
                      : t('wallet.cryptoManageAllChains')}
                  </p>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-5 w-5 text-base-content/45" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          )
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
                {!query.trim() ? addedAssetsSection : null}

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
                        const normalizedChain = normalizeMarketChain(item.chain);
                        const chainLabel =
                          supportedChainByMarketChain.get(normalizedChain)?.name
                          ?? normalizedChain.toUpperCase();
                        return renderTokenRow({
                          key: item.id,
                          symbol: item.symbol,
                          name: item.name,
                          image: item.image,
                          chainLabel,
                          contract: item.contract,
                          buttonLabel: t('wallet.cryptoManageAdd'),
                          buttonClassName: 'btn btn-primary btn-xs shrink-0',
                          onClick: () => handleAddFromSearch(item),
                        });
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

                {addedAssetsSection}

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
