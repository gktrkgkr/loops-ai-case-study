/**
 * State machine – defines valid conversation state transitions.
 * Rejects any transition that is not explicitly allowed.
 */

import { ConversationState } from './types';

const VALID_TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  RECEIVED: ['REASONING_REQUESTED'],
  REASONING_REQUESTED: ['INTENT_VALIDATED', 'FAILED_VALIDATION'],
  INTENT_VALIDATED: ['ACTION_REQUESTED'],
  ACTION_REQUESTED: ['ACTION_COMPLETED', 'FAILED_EXECUTION'],
  ACTION_COMPLETED: [],          // terminal
  FAILED_VALIDATION: [],         // terminal
  FAILED_EXECUTION: [],          // terminal
};

export function validateTransition(
  current: ConversationState,
  next: ConversationState,
): boolean {
  return VALID_TRANSITIONS[current]?.includes(next) ?? false;
}

export function assertTransition(
  current: ConversationState,
  next: ConversationState,
): void {
  if (!validateTransition(current, next)) {
    throw new Error(
      `Invalid state transition: ${current} → ${next}. ` +
      `Allowed from ${current}: [${VALID_TRANSITIONS[current].join(', ')}]`,
    );
  }
}
