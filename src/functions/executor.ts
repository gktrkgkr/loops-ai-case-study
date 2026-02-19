/**
 * Executor Function – Cloud Functions 2nd Gen Pub/Sub Trigger
 *
 * Triggered by: action-requested topic
 *
 * Responsibilities:
 * 1. Receive action_requested events via Pub/Sub trigger
 * 2. Check idempotency receipt (skip duplicates)
 * 3. Execute deterministic tool call (simulated)
 * 4. Persist action result to Firestore
 * 5. Transition state to ACTION_COMPLETED (or FAILED_EXECUTION)
 *
 * Tool calls are DETERMINISTIC and MOCKED: same intent → same result.
 * This guarantees idempotent execution even without receipt checks,
 * but receipts provide defense-in-depth.
 *
 * Ack/Nack: returning normally = ack, throwing = nack (Pub/Sub retries).
 */

import { cloudEvent } from '@google-cloud/functions-framework';
import type { CloudEvent } from '@google-cloud/functions-framework';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentEvent,
  ActionResult,
  claimReceipt,
  completeReceipt,
  logEvent,
  saveActionResult,
  findActionResultByIntentId,
  transitionState,
  MessagePublishedData,
  decodeEventData,
  log,
} from '../shared';



// ── Deterministic Tool Calls ───────────────────────────────

/**
 * Simulates tool execution. Deterministic: same input → same output.
 * In production, these would call real external APIs/tools.
 *
 * Why deterministic: ensures idempotent execution regardless of
 * how many times the same event is delivered.
 */
function executeTool(
  action: string,
  parameters: Record<string, unknown>,
): { success: boolean; result: Record<string, unknown>; error?: string } {
  switch (action) {
    case 'search':
      return {
        success: true,
        result: {
          tool: 'search',
          query: parameters.query,
          results: [
            { title: 'Result 1', snippet: 'Relevant information found for the query.' },
            { title: 'Result 2', snippet: 'Additional context from another source.' },
          ],
          totalResults: 2,
        },
      };

    case 'calculate':
      return {
        success: true,
        result: {
          tool: 'calculate',
          expression: parameters.expression,
          answer: 42,
          note: 'Mocked calculation – always returns 42 for determinism.',
        },
      };

    case 'summarize':
      return {
        success: true,
        result: {
          tool: 'summarize',
          inputLength: String(parameters.text || '').length,
          summary: 'This is a mocked summary of the provided text.',
        },
      };

    case 'translate':
      return {
        success: true,
        result: {
          tool: 'translate',
          targetLang: parameters.targetLang || 'en',
          translation: 'This is a mocked translation output.',
        },
      };

    default:
      return {
        success: false,
        result: {},
        error: `Unknown action: ${action}`,
      };
  }
}

// ── Pub/Sub Trigger Handler ────────────────────────────────

cloudEvent<MessagePublishedData>('executor', async (event: CloudEvent<MessagePublishedData>) => {
  let agentEvent: AgentEvent;
  try {
    agentEvent = decodeEventData(event.data);
  } catch (err: any) {
    log.error('Failed to decode message', { handler: 'executor', error: err.message });
    return;
  }

  const { eventId, conversationId, messageId, payload } = agentEvent;
  log.info('Received event', { handler: 'executor', eventId, conversationId, messageId, eventType: agentEvent.eventType });

  // Idempotency check via transactional receipt
  const isNew = await claimReceipt(eventId, { handler: 'executor', conversationId, messageId });
  if (!isNew) {
    log.info('Duplicate event, skipping', { handler: 'executor', eventId });
    return;
  }

  const action = payload.action as string;
  const parameters = (payload.parameters as Record<string, unknown>) || {};
  const intentId = payload.intentId as string;

  // Defense-in-depth: check if a result already exists for this intent
  const alreadyExecuted = await findActionResultByIntentId(conversationId, intentId);
  if (alreadyExecuted) {
    log.warn('Action result already exists for intent, skipping execution', {
      handler: 'executor', eventId, conversationId, intentId,
    });
    await completeReceipt(eventId);
    return;
  }

  // Execute deterministic tool call
  const { success, result, error } = executeTool(action, parameters);

  const actionResult: ActionResult = {
    actionId: uuidv4(),
    conversationId,
    intentId,
    messageId,
    result,
    executedAt: new Date().toISOString(),
    success,
    error,
  };

  await saveActionResult(actionResult);
  await logEvent(conversationId, eventId, 'action_executed', {
    actionId: actionResult.actionId,
    success,
  });

  if (success) {
    await transitionState(conversationId, 'ACTION_COMPLETED');
    await completeReceipt(eventId);
    log.info('Action completed', { handler: 'executor', eventId, conversationId, actionId: actionResult.actionId });
  } else {
    await transitionState(conversationId, 'FAILED_EXECUTION');
    await completeReceipt(eventId);
    log.error('Action failed', { handler: 'executor', eventId, conversationId, actionId: actionResult.actionId, error });
  }
});
