# Agent Dock MVP

## Goal

Move proactive agent help from an interruptive floating prompt to the existing bottom agent entry. The dock should behave more like an attentive store assistant:

- observe likely struggle signals
- surface lightweight help from the dock first
- let the user opt into deeper assistance
- avoid repeated interruptions

## MVP Scope

Version 1 focuses on four changes:

1. remove the current `idle 5s -> auto bubble` behavior
2. upgrade the bottom agent button into a stateful dock entry
3. add a lightweight help panel before full chat
4. trigger help from three first-pass struggle signals

## Struggle Signals

### 1. Comparison intent

Trigger when the user opens multiple token or market detail pages within a short window.

Dock behavior:

- state: `thinking -> nudging`
- message: "You have been comparing a few assets. I can help summarize the differences."
- primary action: open helper panel and continue into compare-focused chat

### 2. Deep article read

Trigger when the user stays on an article detail page long enough to imply active reading.

Dock behavior:

- state: `observing -> nudging`
- message: "This article has a lot of information. I can summarize the key points."
- primary action: open helper panel and continue into summary-focused chat

### 3. Trade form struggle

Trigger when the user repeatedly edits the trade form or hits quote/submit failures.

Dock behavior:

- state: `warning`
- message: "This step is easy to get wrong. I can help check the order details."
- primary action: open helper panel and continue into check-focused chat

## Dock States

The dock entry uses a small state machine:

- `idle`: no active signal
- `observing`: subtle halo, no message bubble
- `thinking`: stronger halo and a one-shot motion cue
- `nudging`: show bubble above the dock entry
- `engaged`: help panel or chat is open
- `cooldown`: the user dismissed or consumed a suggestion recently

Separate visual mood:

- `neutral`
- `watching`
- `thinking`
- `ready`
- `warning`

## Interaction Model

### Level 1: passive presence

The dock shows state through the button only:

- soft gradient halo
- small status badge / state glyph
- optional mood-specific motion

### Level 2: lightweight nudge

When confidence is higher, show a one-line bubble above the dock:

- no modal
- no auto-open chat
- one primary action through the dock

### Level 3: helper panel

Clicking the dock opens a helper panel first, not generic chat.

Panel content:

- short explanation of what the agent noticed
- one specific suggested help action
- option to continue into free-form chat

### Level 4: chat

If the user chooses to continue, open chat with a task-shaped prompt instead of a blank conversation.

## Frequency Control

Session-level rules for MVP:

- same `signal + entity` only once every 30 minutes
- max two nudges per session
- if the user dismisses a nudge, enter cooldown for that signal/entity
- if the user opens the dock intentionally, suppress more nudges for 30 minutes
- warning-level nudges can bypass some weaker suppression

## Code Plan

### New pieces

- `apps/web/src/hooks/useAgentIntervention.ts`
  - gathers local signals
  - computes dock state, mood, active nudge, cooldown

- `apps/web/src/utils/agentInterventionBus.ts`
  - lightweight event bus for struggle signals from deep components

- `apps/web/src/components/AgentEntryButton.tsx`
  - dock button UI
  - halo, badge, bubble, click and dismiss behavior

### Refactors

- `apps/web/src/components/BottomTabBar.tsx`
  - support dock state props
  - support a dock-only mode for detail pages

- `apps/web/src/components/AgentAssistant.tsx`
  - remove idle-triggered bubble logic
  - add `panel` mode before `chat`
  - accept active nudge / preset task input

- `apps/web/src/App.tsx`
  - wire page context into `useAgentIntervention`
  - always render the dock entry
  - show full tab bar on top-level pages, dock-only on detail pages

- `apps/web/src/components/modals/TradeContent.tsx`
  - publish first-pass trade struggle signals

- `apps/web/src/index.css`
  - add dock state visuals and reduced-motion fallbacks

## MVP Acceptance Criteria

- no more automatic bottom-center prompt after idle
- the agent button can show observing / thinking / ready / warning states
- the agent button can display a one-line bubble
- article detail can trigger a summary nudge
- repeated token/market detail browsing can trigger a compare nudge
- trade failures or repeated form edits can trigger a check nudge
- clicking a nudge opens a helper panel first, then task-focused chat
