export type AgentInterventionSignal =
  | {
      type: 'trade_form_struggle';
      reason: 'repeated_edits' | 'quote_failed' | 'submit_failed';
      entityKey?: string;
    };

const AGENT_INTERVENTION_EVENT = 'agent-intervention-signal';

export function emitAgentInterventionSignal(detail: AgentInterventionSignal): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AgentInterventionSignal>(AGENT_INTERVENTION_EVENT, { detail }));
}

export function subscribeAgentInterventionSignals(
  listener: (signal: AgentInterventionSignal) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<AgentInterventionSignal>;
    if (!customEvent.detail) return;
    listener(customEvent.detail);
  };

  window.addEventListener(AGENT_INTERVENTION_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(AGENT_INTERVENTION_EVENT, handler as EventListener);
  };
}
