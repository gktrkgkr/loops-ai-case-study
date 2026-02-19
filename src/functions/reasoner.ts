/**
 * Reasoner Function – Cloud Functions 2nd Gen Pub/Sub Trigger
 *
 * Triggered by: reasoning-requested topic
 *
 * Responsibilities:
 * 1. Receive reasoning_requested events via Pub/Sub trigger
 * 2. Check idempotency receipt (skip duplicates)
 * 3. Simulate mock LLM reasoning → produce structured intent JSON
 * 4. Validate intent against schema
 * 5. If valid → publish action_requested event, transition to ACTION_REQUESTED
 * 6. If invalid → store rejected intent, transition to FAILED_VALIDATION
 *
 * Reasoning is MOCKED: a deterministic function that maps message content
 * to a structured intent. This keeps the system testable and predictable.
 * Case study explicitly states no real LLM integration is required.
 *
 * Ack/Nack: returning normally = ack, throwing = nack (Pub/Sub retries).
 */

import { cloudEvent } from '@google-cloud/functions-framework';
import type { CloudEvent } from '@google-cloud/functions-framework';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentEvent,
  claimReceipt,
  completeReceipt,
  logEvent,
  saveIntent,
  transitionState,
  publishEvent,
  validateIntent,
  ReasoningIntent,
  MessagePublishedData,
  decodeEventData,
  log,
} from '../shared';

const TOPIC_ACTION = process.env.TOPIC_ACTION || 'action-requested';

// ── Mock Reasoning ─────────────────────────────────────────

/**
 * Simulates LLM reasoning. Deterministic: same input → same output.
 * In production this would call an actual LLM API.
 *
 * The mock demonstrates the contract between reasoning and execution:
 * content keywords → structured intent with action + parameters.
 */
function mockReasoning(
  content: string,
  conversationId: string,
  messageId: string,
): Record<string, unknown> {
  const lower = content.toLowerCase();

  if (lower.includes('search') || lower.includes('find')) {
    return {
      intentId: uuidv4(),
      conversationId,
      messageId,
      action: 'search',
      parameters: { query: content },
      confidence: 0.92,
    };
  }
  if (lower.includes('calculate') || lower.includes('compute') || lower.includes('math')) {
    return {
      intentId: uuidv4(),
      conversationId,
      messageId,
      action: 'calculate',
      parameters: { expression: content },
      confidence: 0.88,
    };
  }
  if (lower.includes('summarize') || lower.includes('summary')) {
    return {
      intentId: uuidv4(),
      conversationId,
      messageId,
      action: 'summarize',
      parameters: { text: content },
      confidence: 0.85,
    };
  }
  if (lower.includes('translate')) {
    return {
      intentId: uuidv4(),
      conversationId,
      messageId,
      action: 'translate',
      parameters: { text: content, targetLang: 'en' },
      confidence: 0.90,
    };
  }

  // Default: still produces a valid intent (search fallback)
  return {
    intentId: uuidv4(),
    conversationId,
    messageId,
    action: 'search',
    parameters: { query: content },
    confidence: 0.60,
  };
}

// ── Pub/Sub Trigger Handler ────────────────────────────────

cloudEvent<MessagePublishedData>('reasoner', async (event: CloudEvent<MessagePublishedData>) => {
  let agentEvent: AgentEvent;
  try {
    agentEvent = decodeEventData(event.data);
  } catch (err: any) {
    log.error('Failed to decode message', { handler: 'reasoner', error: err.message });
    return;
  }

  const { eventId, conversationId, messageId, payload } = agentEvent;
  log.info('Received event', { handler: 'reasoner', eventId, conversationId, messageId, eventType: agentEvent.eventType });

  // Idempotency check via transactional receipt
  const isNew = await claimReceipt(eventId, { handler: 'reasoner', conversationId, messageId });
  if (!isNew) {
    log.info('Duplicate event, skipping', { handler: 'reasoner', eventId });
    return;
  }

  // Simulate reasoning
  const content = (payload.content as string) || '';
  const rawIntent = mockReasoning(content, conversationId, messageId);

  // Validate intent schema before execution
  const validation = validateIntent(rawIntent);

  const intentDoc: ReasoningIntent = {
    intentId: (rawIntent.intentId as string) || uuidv4(),
    conversationId,
    messageId,
    action: (rawIntent.action as string) || 'unknown',
    parameters: (rawIntent.parameters as Record<string, unknown>) || {},
    confidence: (rawIntent.confidence as number) || 0,
    createdAt: new Date().toISOString(),
    valid: validation.valid,
    validationError: validation.error,
  };

  await saveIntent(intentDoc);
  await logEvent(conversationId, eventId, 'reasoning_completed', {
    intentId: intentDoc.intentId,
    valid: validation.valid,
  });

  if (!validation.valid) {
    log.warn('Intent validation failed', { handler: 'reasoner', eventId, conversationId, intentId: intentDoc.intentId, error: validation.error });
    await transitionState(conversationId, 'FAILED_VALIDATION');
    await completeReceipt(eventId);
    return;
  }

  // Transition to INTENT_VALIDATED first
  await transitionState(conversationId, 'INTENT_VALIDATED');

  // Publish action_requested event for executor
  const actionEventId = uuidv4();
  const actionEvent: AgentEvent = {
    eventId: actionEventId,
    eventType: 'action_requested',
    conversationId,
    messageId,
    timestamp: new Date().toISOString(),
    producer: 'reasoner',
    payload: {
      intentId: intentDoc.intentId,
      action: intentDoc.action,
      parameters: intentDoc.parameters,
      confidence: intentDoc.confidence,
    },
  };

  await publishEvent(TOPIC_ACTION, actionEvent);
  await transitionState(conversationId, 'ACTION_REQUESTED');
  await completeReceipt(eventId);

  log.info('Published action_requested', { handler: 'reasoner', eventId: actionEventId, conversationId, intentId: intentDoc.intentId });
});
