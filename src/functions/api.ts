/**
 * API Function – Cloud Functions 2nd Gen HTTP Trigger
 *
 * Responsibilities:
 * 1. Accept user messages via POST /messages
 * 2. Deduplicate via client idempotency key (X-Idempotency-Key header)
 * 3. Create conversation + persist message to Firestore
 * 4. Publish reasoning_requested event to Pub/Sub
 * 5. Transition state: RECEIVED → REASONING_REQUESTED
 *
 * GET /conversations/:id returns current conversation state (for verification).
 */

import { http } from '@google-cloud/functions-framework';
import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentEvent,
  createConversation,
  getConversation,
  transitionState,
  saveMessage,
  claimIdempotencyKey,
  logEvent,
  publishEvent,
  log,
} from '../shared';

const app = express();
app.use(express.json());

const TOPIC_REASONING = process.env.TOPIC_REASONING || 'reasoning-requested';

// ── POST /messages ─────────────────────────────────────────

app.post('/messages', async (req: Request, res: Response): Promise<void> => {
  try {
    const { content, conversationId: existingConvId } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "content" field' });
      return;
    }

    // Create or reuse conversation
    const conversationId = existingConvId || uuidv4();
    const messageId = uuidv4();

    // Client idempotency — transactional claim to prevent TOCTOU race
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
    if (idempotencyKey) {
      const claim = await claimIdempotencyKey(idempotencyKey, messageId);
      if (!claim.isNew) {
        log.info('Duplicate request detected', { handler: 'api', conversationId, idempotencyKey });
        res.status(200).json({
          messageId: claim.existingMessageId,
          duplicate: true,
          message: 'Request already processed',
        });
        return;
      }
    }

    if (!existingConvId) {
      await createConversation(conversationId);
      log.info('Created conversation', { handler: 'api', conversationId });
    }

    // Persist message
    await saveMessage({
      messageId,
      conversationId,
      content,
      createdAt: new Date().toISOString(),
      idempotencyKey,
    });
    log.info('Saved message', { handler: 'api', conversationId, messageId });

    // Build and publish event
    const eventId = uuidv4();
    const event: AgentEvent = {
      eventId,
      eventType: 'reasoning_requested',
      conversationId,
      messageId,
      timestamp: new Date().toISOString(),
      producer: 'api',
      payload: { content },
    };

    await logEvent(conversationId, eventId, 'reasoning_requested', { content });
    await publishEvent(TOPIC_REASONING, event);

    // Transition state
    await transitionState(conversationId, 'REASONING_REQUESTED');

    res.status(201).json({
      messageId,
      conversationId,
      eventId,
      state: 'REASONING_REQUESTED',
    });
  } catch (err: any) {
    log.error('Error processing message', { handler: 'api', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /conversations/:id ─────────────────────────────────

app.get('/conversations/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const conversationId = req.params.id as string;
    const conversation = await getConversation(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json(conversation);
  } catch (err: any) {
    log.error('Error fetching conversation', { handler: 'api', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api' });
});

// ── Register as Cloud Function ─────────────────────────────

http('api', (req, res) => {
  app(req, res);
});
