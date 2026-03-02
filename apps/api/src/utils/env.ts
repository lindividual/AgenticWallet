import { MEEVersion } from '@biconomy/abstractjs';

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.includes('replace-with-') || normalized.endsWith('/replace') || normalized === 'replace';
}

export function requiredEnv(value: string | undefined, key: string): string {
  const resolved = value?.trim();
  if (!resolved) {
    throw new Error(`${key}_is_required`);
  }
  if (isPlaceholderValue(resolved)) {
    throw new Error(`invalid_${key}_placeholder`);
  }
  return resolved;
}

export function resolveMeeVersion(raw: string | undefined): MEEVersion {
  const normalized = raw?.trim();
  if (!normalized) return MEEVersion.V2_2_1;

  const matched = Object.values(MEEVersion).find((v) => v === normalized);
  if (!matched) {
    throw new Error(`invalid_BICONOMY_MEE_VERSION_${normalized}`);
  }
  return matched;
}
