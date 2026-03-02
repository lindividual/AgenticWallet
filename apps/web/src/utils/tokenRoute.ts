const NATIVE_CONTRACT_PARAM = 'native';

export function encodeTokenContractParam(contract: string): string {
  const normalized = contract.trim();
  return normalized ? normalized : NATIVE_CONTRACT_PARAM;
}

export function decodeTokenContractParam(contractParam: string): string {
  const normalized = contractParam.trim();
  return normalized.toLowerCase() === NATIVE_CONTRACT_PARAM ? '' : normalized;
}

