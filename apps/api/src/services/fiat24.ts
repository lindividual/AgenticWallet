import { createPublicClient, http, isAddress, type Address } from 'viem';
import { arbitrum } from 'viem/chains';
import type { Bindings, Fiat24CardSnapshot, WalletSummary } from '../types';
import { ARBITRUM_NETWORK_KEY, EVM_PROTOCOL, getWalletChainAddress } from './wallet';

const FIAT24_ACCOUNT_NFT_CONTRACT = '0x133CAEecA096cA54889db71956c7f75862Ead7A0' as Address;

const ERC721_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

function buildFiat24CardSnapshot(
  partial: Partial<Fiat24CardSnapshot>,
): Fiat24CardSnapshot {
  return {
    available: false,
    opened: false,
    chainId: 42161,
    chain: 'arbitrum',
    contractAddress: FIAT24_ACCOUNT_NFT_CONTRACT,
    ownerAddress: null,
    nftBalance: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

export async function getFiat24CardSafe(
  env: Bindings,
  wallet: WalletSummary,
): Promise<Fiat24CardSnapshot> {
  const ownerCandidate = getWalletChainAddress(wallet, ARBITRUM_NETWORK_KEY, EVM_PROTOCOL);
  const ownerAddress = typeof ownerCandidate === 'string' && isAddress(ownerCandidate)
    ? ownerCandidate as Address
    : null;

  if (!ownerAddress) {
    return buildFiat24CardSnapshot({
      error: 'wallet_address_unavailable',
    });
  }

  try {
    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(env.ARBITRUM_RPC_URL?.trim() || undefined),
    });
    const nftBalance = await publicClient.readContract({
      address: FIAT24_ACCOUNT_NFT_CONTRACT,
      abi: ERC721_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });

    return buildFiat24CardSnapshot({
      available: true,
      opened: nftBalance > 0n,
      ownerAddress,
      nftBalance: nftBalance.toString(),
      error: null,
    });
  } catch (error) {
    return buildFiat24CardSnapshot({
      ownerAddress,
      error: error instanceof Error ? error.message : 'fiat24_card_check_failed',
    });
  }
}
