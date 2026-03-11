import { Bot, Eye, MessageCircleMore, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { AgentEntryState, AgentMood } from '../agent/types';

type AgentEntryButtonProps = {
  bubbleMessage?: string | null;
  dockOnly?: boolean;
  mood: AgentMood;
  onDismissBubble?: () => void;
  onOpen: () => void;
  state: AgentEntryState;
  title: string;
};

function MoodGlyph({ mood }: { mood: AgentMood }) {
  if (mood === 'watching') {
    return <Eye size={11} strokeWidth={2.1} />;
  }
  if (mood === 'thinking') {
    return <Sparkles size={11} strokeWidth={2.1} />;
  }
  if (mood === 'ready') {
    return <MessageCircleMore size={11} strokeWidth={2.1} />;
  }
  if (mood === 'warning') {
    return <TriangleAlert size={11} strokeWidth={2.1} />;
  }
  return null;
}

export function AgentEntryButton({
  bubbleMessage,
  dockOnly = false,
  mood,
  onDismissBubble,
  onOpen,
  state,
  title,
}: AgentEntryButtonProps) {
  return (
    <div className={`agent-entry-shell ${dockOnly ? 'agent-entry-shell--solo' : ''}`}>
      {bubbleMessage ? (
        <div className="agent-entry-bubble agent-entry-bubble-enter" role="status" aria-live="polite">
          <button type="button" className="agent-entry-bubble__body" onClick={onOpen}>
            <span className="agent-entry-bubble__text">{bubbleMessage}</span>
          </button>
          {onDismissBubble ? (
            <button
              type="button"
              className="agent-entry-bubble__dismiss"
              onClick={onDismissBubble}
              aria-label="Dismiss agent suggestion"
            >
              <X size={12} strokeWidth={2.3} />
            </button>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        className={`liquid-agent-button liquid-agent-button--${state} liquid-agent-button--mood-${mood}`}
        onClick={onOpen}
        aria-label={title}
        data-mood={mood}
      >
        <span className="liquid-agent-button__halo" aria-hidden="true" />
        <Bot size={24} strokeWidth={2.05} />
        <span className="liquid-agent-button__badge" aria-hidden="true">
          <MoodGlyph mood={mood} />
        </span>
      </button>
    </div>
  );
}
