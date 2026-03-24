export type AgentChatTransferAction = {
  type: 'transfer_preview';
  networkKey: string;
  toAddress: string;
  amount: string;
  tokenSymbol?: string | null;
  tokenAddress?: string | null;
  tokenDecimals?: number | null;
};

export type AgentChatQuickReplyOption = {
  label: string;
  message?: string | null;
};

export type AgentChatQuickRepliesAction = {
  type: 'quick_replies';
  options: AgentChatQuickReplyOption[];
};

export type AgentChatAction = AgentChatTransferAction | AgentChatQuickRepliesAction;

export function normalizeAgentChatPayload(payload: Record<string, unknown>): { reply: string; actions: AgentChatAction[] } | null {
  const reply = typeof payload.reply === 'string'
    ? payload.reply.trim()
    : typeof payload.assistantReply === 'string'
      ? payload.assistantReply.trim()
      : '';
  const actions = Array.isArray(payload.actions)
    ? payload.actions
      .map((action) => normalizeAgentChatAction(action))
      .filter((action): action is AgentChatAction => Boolean(action))
    : [];

  if (!reply) {
    const directAction = normalizeAgentChatAction(payload);
    if (directAction) {
      return {
        reply: '',
        actions: actions.length > 0 ? [...actions, directAction] : [directAction],
      };
    }
    if (actions.length > 0) {
      return {
        reply: '',
        actions,
      };
    }
    return null;
  }

  return { reply, actions };
}

export function normalizeAgentChatAction(input: unknown): AgentChatAction | null {
  if (!input || typeof input !== 'object') return null;
  const payload = input as Record<string, unknown>;
  const type = typeof payload.type === 'string' ? payload.type.trim() : '';
  if (type === 'quick_replies') {
    const options = Array.isArray(payload.options)
      ? payload.options
        .map((option) => normalizeAgentChatQuickReplyOption(option))
        .filter((option): option is AgentChatQuickReplyOption => Boolean(option))
        .slice(0, 4)
      : [];
    if (options.length === 0) return null;
    return {
      type: 'quick_replies',
      options,
    };
  }

  if (type !== 'transfer_preview') return null;

  const networkKey = typeof payload.networkKey === 'string' ? payload.networkKey.trim().toLowerCase() : '';
  const toAddress = typeof payload.toAddress === 'string' ? payload.toAddress.trim() : '';
  const amount = typeof payload.amount === 'string' ? payload.amount.trim() : '';
  const tokenSymbol = typeof payload.tokenSymbol === 'string' ? payload.tokenSymbol.trim().slice(0, 32) : null;
  const tokenAddress = typeof payload.tokenAddress === 'string' ? payload.tokenAddress.trim() : null;
  const tokenDecimalsValue = typeof payload.tokenDecimals === 'number' ? payload.tokenDecimals : null;
  const tokenDecimals = Number.isFinite(tokenDecimalsValue) && tokenDecimalsValue != null
    ? Math.max(0, Math.min(36, Math.trunc(tokenDecimalsValue)))
    : null;

  if (!networkKey || !toAddress || !amount) return null;

  return {
    type: 'transfer_preview',
    networkKey,
    toAddress,
    amount,
    tokenSymbol: tokenSymbol || null,
    tokenAddress: tokenAddress || null,
    tokenDecimals,
  };
}

export function normalizeAgentChatQuickReplyOption(input: unknown): AgentChatQuickReplyOption | null {
  if (typeof input === 'string') {
    const value = input.trim().slice(0, 80);
    if (!value) return null;
    return { label: value, message: value };
  }
  if (!input || typeof input !== 'object') return null;

  const payload = input as Record<string, unknown>;
  const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
  const message = typeof payload.message === 'string' ? payload.message.trim().slice(0, 280) : '';
  if (!label) return null;

  return {
    label,
    message: message || label,
  };
}
