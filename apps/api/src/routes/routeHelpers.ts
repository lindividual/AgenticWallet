type JsonBodyReader = {
  json(): Promise<unknown>;
};

type ErrorStatusRule<StatusCode extends number = number> = {
  status: StatusCode;
  equals?: readonly string[];
  startsWith?: readonly string[];
  includes?: readonly string[];
};

const TRADE_ERROR_STATUS_RULES = [
  {
    status: 400,
    equals: ['unsupported_chain', 'wallet_key_decryption_failed'],
    startsWith: ['invalid_', 'insufficient_'],
    includes: ['trade_provider_invalid_response'],
  },
  {
    status: 404,
    equals: ['wallet_not_found'],
  },
] as const satisfies readonly ErrorStatusRule<400 | 404>[];

const TRANSFER_ERROR_STATUS_RULES = [
  {
    status: 400,
    equals: [
      'unsupported_fee_token',
      'unsupported_bitcoin_token_transfer',
      'unsupported_chain',
      'wallet_key_decryption_failed',
      'wallet_key_mismatch',
    ],
    startsWith: ['invalid_', 'insufficient_'],
    includes: ['insufficient balance to pay for the gas', 'orchestration fee'],
  },
  {
    status: 404,
    equals: ['wallet_not_found'],
  },
] as const satisfies readonly ErrorStatusRule<400 | 404>[];

const PERPS_ERROR_STATUS_RULES = [
  {
    status: 400,
    equals: ['wallet_key_decryption_failed'],
    startsWith: ['invalid_', 'perps_cross_margin_unsupported'],
  },
] as const satisfies readonly ErrorStatusRule<400>[];

const PREDICTION_ERROR_STATUS_RULES = [
  {
    status: 400,
    startsWith: ['invalid_', 'unsupported_', 'prediction_order_rejected', 'prediction_activation_required'],
    includes: ['prediction_order_rejected', 'prediction_activation_required'],
  },
  {
    status: 404,
    equals: ['wallet_not_found'],
  },
] as const satisfies readonly ErrorStatusRule<400 | 404>[];

export async function readJsonBody<T>(request: JsonBodyReader): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function resolveErrorStatus<StatusCode extends number>(
  error: unknown,
  rules: readonly ErrorStatusRule<StatusCode>[],
  fallbackStatus: StatusCode,
): StatusCode {
  const message = getErrorMessage(error, 'unknown_error');
  const normalizedMessage = message.toLowerCase();

  for (const rule of rules) {
    if (rule.equals?.includes(message)) {
      return rule.status;
    }

    if (rule.startsWith?.some((prefix) => message.startsWith(prefix))) {
      return rule.status;
    }

    if (rule.includes?.some((fragment) => normalizedMessage.includes(fragment.toLowerCase()))) {
      return rule.status;
    }
  }

  return fallbackStatus;
}

export function toTradeErrorStatus(error: unknown): 400 | 404 | 502 {
  return resolveErrorStatus(error, TRADE_ERROR_STATUS_RULES, 502);
}

export function toTransferErrorStatus(error: unknown): 400 | 404 | 502 {
  return resolveErrorStatus(error, TRANSFER_ERROR_STATUS_RULES, 502);
}

export function toPerpsErrorStatus(error: unknown): 400 | 502 {
  return resolveErrorStatus(error, PERPS_ERROR_STATUS_RULES, 502);
}

export function toPredictionErrorStatus(error: unknown): 400 | 404 | 502 {
  return resolveErrorStatus(error, PREDICTION_ERROR_STATUS_RULES, 502);
}
