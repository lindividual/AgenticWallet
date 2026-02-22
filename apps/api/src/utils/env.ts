import { DEFAULT_MEE_VERSION, MEEVersion } from '@biconomy/abstractjs';

export function requiredEnv(value: string | undefined, key: string): string {
  const resolved = value?.trim();
  if (!resolved) {
    throw new Error(`${key}_is_required`);
  }
  return resolved;
}

export function resolveMeeVersion(raw: string | undefined): MEEVersion {
  const normalized = raw?.trim();
  if (!normalized) return DEFAULT_MEE_VERSION;

  const matched = Object.values(MEEVersion).find((v) => v === normalized);
  if (!matched) {
    throw new Error(`invalid_BICONOMY_MEE_VERSION_${normalized}`);
  }
  return matched;
}
