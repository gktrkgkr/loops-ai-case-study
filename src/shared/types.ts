/**
 * Event contract types for the AI agent pipeline.
 * Every event flowing through Pub/Sub conforms to this structure.
 */

export interface AgentEvent {
  /** Globally unique event identifier – used for idempotency */
  eventId: string;
  /** Discriminator for event type */
  eventType: 'reasoning_requested' | 'action_requested';
  /** Conversation this event belongs to */
  conversationId: string;
  /** Originating user message */
  messageId: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Service that produced this event */
  producer: 'api' | 'reasoner' | 'executor';
  /** Event-specific payload */
  payload: Record<string, unknown>;
}

/** Conversation state machine */
export type ConversationState =
  | 'RECEIVED'
  | 'REASONING_REQUESTED'
  | 'INTENT_VALIDATED'
  | 'ACTION_REQUESTED'
  | 'ACTION_COMPLETED'
  | 'FAILED_VALIDATION'
  | 'FAILED_EXECUTION';

/** Firestore conversation document */
export interface Conversation {
  conversationId: string;
  state: ConversationState;
  createdAt: string;
  updatedAt: string;
}

/** User message stored in Firestore */
export interface UserMessage {
  messageId: string;
  conversationId: string;
  content: string;
  createdAt: string;
  /** Client-supplied idempotency key to prevent duplicate API submissions */
  idempotencyKey?: string;
}

/** Structured intent produced by the reasoner */
export interface ReasoningIntent {
  intentId: string;
  conversationId: string;
  messageId: string;
  action: string;
  parameters: Record<string, unknown>;
  confidence: number;
  createdAt: string;
  valid: boolean;
  validationError?: string;
}

/** Action execution result */
export interface ActionResult {
  actionId: string;
  conversationId: string;
  intentId: string;
  messageId: string;
  result: Record<string, unknown>;
  executedAt: string;
  success: boolean;
  error?: string;
}
