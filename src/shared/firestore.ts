/**
 * Firestore client wrapper.
 *
 * Centralises all Firestore operations and provides:
 * - Conversation CRUD with state machine enforcement
 * - Message persistence
 * - Idempotency receipt checks (transactional)
 * - Event logging
 * - Intent and action result storage
 */

import { Firestore } from '@google-cloud/firestore';
import { assertTransition } from './state-machine';
import {
  Conversation,
  ConversationState,
  UserMessage,
  ReasoningIntent,
  ActionResult,
} from './types';

let db: Firestore;

export function getFirestore(): Firestore {
  if (!db) {
    db = new Firestore({ ignoreUndefinedProperties: true });
  }
  return db;
}

// ── Conversations ──────────────────────────────────────────

export async function createConversation(conversationId: string): Promise<Conversation> {
  const now = new Date().toISOString();
  const conversation: Conversation = {
    conversationId,
    state: 'RECEIVED',
    createdAt: now,
    updatedAt: now,
  };
  await getFirestore()
    .collection('conversations')
    .doc(conversationId)
    .set(conversation);
  return conversation;
}

export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const snap = await getFirestore()
    .collection('conversations')
    .doc(conversationId)
    .get();
  return snap.exists ? (snap.data() as Conversation) : null;
}

export async function transitionState(
  conversationId: string,
  nextState: ConversationState,
): Promise<void> {
  const ref = getFirestore().collection('conversations').doc(conversationId);

  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Conversation ${conversationId} not found`);
    const current = snap.data() as Conversation;
    assertTransition(current.state, nextState);
    tx.update(ref, {
      state: nextState,
      updatedAt: new Date().toISOString(),
    });
  });
}

// ── Messages ───────────────────────────────────────────────

export async function saveMessage(msg: UserMessage): Promise<void> {
  await getFirestore()
    .collection('conversations')
    .doc(msg.conversationId)
    .collection('messages')
    .doc(msg.messageId)
    .set(msg);
}

// ── Idempotency Receipts ───────────────────────────────────

/**
 * Stale receipt threshold (ms).
 * If a receipt has been in "processing" longer than this, it is considered
 * stuck (the consumer likely crashed) and can be reclaimed by a Pub/Sub
 * redelivery. This does NOT break idempotency because:
 *   - Reasoner: re-publishing the same intent (same eventId) is a no-op on the executor side.
 *   - Executor: checks for existing action results before executing (defense-in-depth).
 */
const RECEIPT_STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Tries to claim a receipt for the given eventId inside a transaction.
 *
 * Possible outcomes:
 *   1. No receipt exists          → create it, return true  (process the event)
 *   2. Receipt exists, completed  → return false            (duplicate – skip)
 *   3. Receipt exists, processing, recent → return false    (another instance is working on it)
 *   4. Receipt exists, processing, stale  → reclaim it, return true (original consumer crashed)
 *
 * Receipts are enriched with handler name, conversation context, and status
 * so they double as an operational audit trail for debugging.
 */
export async function claimReceipt(
  eventId: string,
  meta: { handler: string; conversationId: string; messageId: string },
): Promise<boolean> {
  const ref = getFirestore().collection('receipts').doc(eventId);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (snap.exists) {
      const data = snap.data()!;

      // Already completed — genuine duplicate, skip.
      if (data.status === 'completed') return false;

      // Still processing — check if it's stale (consumer crashed).
      if (data.status === 'processing' && data.claimedAt) {
        const claimedAt = new Date(data.claimedAt).getTime();
        const age = Date.now() - claimedAt;
        if (age < RECEIPT_STALE_THRESHOLD_MS) {
          return false;                           // another instance is actively working
        }
        // Stale receipt — reclaim for retry.
        tx.update(ref, {
          status: 'processing',
          claimedAt: new Date().toISOString(),
          retriedAt: new Date().toISOString(),
        });
        return true;
      }

      return false;                               // unknown status — safe default
    }

    // No receipt — first attempt.
    tx.set(ref, {
      eventId,
      handler: meta.handler,
      conversationId: meta.conversationId,
      messageId: meta.messageId,
      status: 'processing',
      claimedAt: new Date().toISOString(),
    });
    return true;
  });
}

/**
 * Mark a receipt as completed after successful processing.
 * Uses set-with-merge to be resilient against the edge case where
 * the receipt doc was lost (partial Firestore failure). A plain
 * update() would throw if the doc didn’t exist, causing a Pub/Sub
 * retry that could lead to double side-effects.
 */
export async function completeReceipt(eventId: string): Promise<void> {
  await getFirestore().collection('receipts').doc(eventId).set(
    {
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}

// ── Client Idempotency Key ─────────────────────────────────

/**
 * Atomically claim a client idempotency key inside a Firestore transaction.
 * Returns { isNew: true } if the key was freshly claimed (proceed with request).
 * Returns { isNew: false, existingMessageId } if the key already existed (duplicate).
 *
 * Without a transaction, two concurrent requests with the same key could both
 * pass the "does it exist?" check before either writes — a classic TOCTOU race.
 */
export async function claimIdempotencyKey(
  key: string,
  messageId: string,
): Promise<{ isNew: true } | { isNew: false; existingMessageId: string }> {
  const ref = getFirestore().collection('idempotencyKeys').doc(key);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data() as { messageId: string };
      return { isNew: false as const, existingMessageId: data.messageId };
    }
    tx.set(ref, { messageId, createdAt: new Date().toISOString() });
    return { isNew: true as const };
  });
}

// ── Event Log ──────────────────────────────────────────────

export async function logEvent(
  conversationId: string,
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await getFirestore()
    .collection('conversations')
    .doc(conversationId)
    .collection('events')
    .doc(eventId)
    .set({
      eventId,
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    });
}

// ── Intents ────────────────────────────────────────────────

export async function saveIntent(intent: ReasoningIntent): Promise<void> {
  await getFirestore()
    .collection('conversations')
    .doc(intent.conversationId)
    .collection('intents')
    .doc(intent.intentId)
    .set(intent);
}

// ── Action Results ─────────────────────────────────────────

export async function saveActionResult(result: ActionResult): Promise<void> {
  await getFirestore()
    .collection('conversations')
    .doc(result.conversationId)
    .collection('actions')
    .doc(result.actionId)
    .set(result);
}

/**
 * Check if an action result already exists for a given intentId.
 * Used as defense-in-depth in the executor: even if the receipt check
 * is bypassed (e.g., partial failure), we avoid duplicate execution.
 */
export async function findActionResultByIntentId(
  conversationId: string,
  intentId: string,
): Promise<boolean> {
  const snapshot = await getFirestore()
    .collection('conversations')
    .doc(conversationId)
    .collection('actions')
    .where('intentId', '==', intentId)
    .limit(1)
    .get();
  return !snapshot.empty;
}
