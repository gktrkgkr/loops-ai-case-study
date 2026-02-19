# Loops AI – Senior Backend Engineer Case Study

Event-driven AI agent backend on **Cloud Functions 2nd gen**, **Pub/Sub**, and **Firestore**.

Live: `https://europe-west1-loops-case-study-487816.cloudfunctions.net/api`

---

## Architecture

```
┌────────┐     ┌───────────────┐     ┌────────────────┐     ┌────────────────┐
│ Client │────▶│ API (HTTP)    │────▶│ Reasoner       │────▶│ Executor       │
│        │     │               │     │ (Pub/Sub)      │     │ (Pub/Sub)      │
└────────┘     └───────┬───────┘     └───────┬────────┘     └───────┬────────┘
                       │                     │                      │
                       └─────────── Firestore ──────────────────────┘
```

| Function | Trigger | What it does |
|----------|---------|--------------|
| `api` | HTTP | Accepts messages, persists to Firestore, publishes `reasoning_requested` |
| `reasoner` | Pub/Sub: `reasoning-requested` | Mock LLM reasoning → validates intent via Zod → publishes `action_requested` |
| `executor` | Pub/Sub: `action-requested` | Deterministic tool call → persists result → completes conversation |

---

## API Reference

Base URL: `https://europe-west1-loops-case-study-487816.cloudfunctions.net/api`

### POST /messages

Send a user message and trigger the reasoning → execution pipeline.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `X-Idempotency-Key` | No | Prevents duplicate processing. Same key → returns original response. |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string` | Yes | The user message (keywords like `search`, `calculate`, `summarize`, `translate` trigger different actions) |
| `conversationId` | `string` | No | Reuse an existing conversation. If omitted, a new one is created. |

**Example:**

```bash
curl -X POST https://europe-west1-loops-case-study-487816.cloudfunctions.net/api/messages \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: my-unique-key-123" \
  -d '{"content": "search for event-driven architectures"}'
```

**Response (201):**

```json
{
  "messageId": "a1b2c3d4-...",
  "conversationId": "e5f6g7h8-...",
  "eventId": "i9j0k1l2-...",
  "state": "REASONING_REQUESTED"
}
```

**Response (200 — duplicate):**

```json
{
  "messageId": "a1b2c3d4-...",
  "duplicate": true,
  "message": "Request already processed"
}
```

**Response (400 — validation error):**

```json
{ "error": "Missing or invalid \"content\" field" }
```

---

### GET /conversations/:id

Check the current state of a conversation and verify pipeline completion.

**Example:**

```bash
curl https://europe-west1-loops-case-study-487816.cloudfunctions.net/api/conversations/e5f6g7h8-...
```

**Response (200):**

```json
{
  "conversationId": "e5f6g7h8-...",
  "state": "ACTION_COMPLETED",
  "createdAt": "2026-02-19T10:00:00.000Z",
  "updatedAt": "2026-02-19T10:00:08.000Z"
}
```

**Response (404):**

```json
{ "error": "Conversation not found" }
```

> **Note:** After sending a message, the conversation state progresses through the pipeline asynchronously. Poll this endpoint to verify the final state (`ACTION_COMPLETED`, `FAILED_VALIDATION`, or `FAILED_EXECUTION`).

---

### GET /health

```bash
curl https://europe-west1-loops-case-study-487816.cloudfunctions.net/api/health
```

**Response (200):**

```json
{ "status": "ok", "service": "api" }
```

---

## Project Structure

```
src/
├── index.ts                 # Registers all Cloud Functions
├── functions/
│   ├── api.ts               # HTTP trigger
│   ├── reasoner.ts          # Pub/Sub trigger
│   └── executor.ts          # Pub/Sub trigger
└── shared/
    ├── types.ts             # AgentEvent, Conversation, etc.
    ├── state-machine.ts     # State transition enforcement
    ├── schema.ts            # Zod validation for intents
    ├── firestore.ts         # All Firestore ops + idempotency receipts
    ├── pubsub.ts            # Publish + CloudEvent decode
    └── logger.ts            # Structured JSON logging for Cloud Logging
```

---

## State Machine

```
RECEIVED → REASONING_REQUESTED → INTENT_VALIDATED → ACTION_REQUESTED → ACTION_COMPLETED
                    │                                       │
                    └→ FAILED_VALIDATION                    └→ FAILED_EXECUTION
```

Every transition is enforced inside a Firestore transaction. Invalid transitions throw.

---

## Idempotency Strategy

Two independent layers:

**1. Client-side (API):** Optional `X-Idempotency-Key` header. The key is claimed inside a **Firestore transaction** — even if two identical requests arrive simultaneously, only one wins:

```typescript
return db.runTransaction(async (tx) => {
  const snap = await tx.get(keyRef);
  if (snap.exists) return { isNew: false, existingMessageId: snap.data().messageId };
  tx.set(keyRef, { messageId, createdAt: ... });
  return { isNew: true };
});
```

The duplicate request gets the original `messageId` back with `duplicate: true` — no new message or event is created.

**2. Pub/Sub event-level (Reasoner + Executor):** Each event has a unique `eventId`. Before processing, the consumer runs `claimReceipt(eventId)` with the same transactional pattern. Only the first delivery processes; concurrent redeliveries are safely skipped.

Additionally, tool calls are **deterministic** (same input → same output), providing defense-in-depth.

**3. Executor result existence check (defense-in-depth):** Before executing a tool call, the executor queries Firestore to check if an action result already exists for the same `intentId`. This guards against the edge case where a receipt was claimed but the process crashed before completing — on retry, the receipt blocks it, but if the receipt was somehow lost, this second check prevents duplicate execution.

**Receipt audit trail:** Receipts are not minimal tombstones. Each receipt records `handler`, `conversationId`, `messageId`, `status` (`processing` → `completed`), `claimedAt`, and `completedAt`. This makes them useful for operational debugging — a stuck receipt in `processing` status signals a crash between claim and completion.

**Stuck receipt recovery:** If a receipt stays in `processing` for longer than 2 minutes, `claimReceipt()` treats it as stale and reclaims it, allowing the event to be retried. This closes the gap where a consumer crashes after claiming but before completing — previously this left the event permanently stuck.

```typescript
// Inside claimReceipt transaction:
if (snap.exists) {
  if (data.status === 'completed') return false;  // true duplicate
  const age = Date.now() - new Date(data.claimedAt).getTime();
  if (age < STALE_THRESHOLD) return false;         // still processing
  tx.update(ref, { status: 'processing', claimedAt: now, retriedAt: now });
  return true;                                     // stale → reclaim
}
```

---

## Retry & Dead Letter Strategy

Retry is handled by **Pub/Sub's built-in mechanism** — not application code:

- Function returns normally → message **acked** (done)
- Function throws/crashes → message **nacked** → Pub/Sub redelivers automatically
- Each subscription is configured with **max 5 delivery attempts**
- After 5 failures → message forwarded to a **dead letter topic** (not silently dropped)

| Subscription | Dead Letter Topic | Pull Subscription |
|---|---|---|
| `reasoner` (reasoning-requested) | `reasoning-dead-letter` | `reasoning-dead-letter-sub` |
| `executor` (action-requested) | `action-dead-letter` | `action-dead-letter-sub` |

Dead letter messages are retained for 7 days and can be inspected:
```bash
gcloud pubsub subscriptions pull reasoning-dead-letter-sub --auto-ack
```

---

## Failure Scenarios

| Scenario | Outcome |
|----------|---------|
| Pub/Sub delivers same event twice | Receipt check skips the duplicate |
| Consumer crashes before processing | No receipt created → Pub/Sub redelivers → processed normally |
| Consumer crashes after receipt, before completion | Receipt stays in `processing` → after 2 min, `claimReceipt` reclaims it → Pub/Sub retry succeeds |
| Message fails 5 times | Routed to dead letter topic for inspection |
| Invalid reasoning output | Zod rejects → stored with `valid: false` → never reaches executor |
| Unknown tool action | Executor returns `success: false` → state → `FAILED_EXECUTION` |
| Malformed Pub/Sub message | Acked immediately to prevent infinite redelivery loop |
| Two concurrent requests with same idempotency key | Firestore transaction ensures only one wins |

---

## Design Decisions

**Cloud Functions vs Cloud Run:** Started with Cloud Run containers + Dockerfile + a local runner that duplicated all handler logic. Migrated to Cloud Functions 2nd gen because it eliminates Express boilerplate for Pub/Sub consumers, handles ack/nack automatically, and wires subscriptions via Eventarc. Less code, same architecture. Note: Cloud Functions 2nd gen runs on Cloud Run under the hood — the same stateless container constraints apply, but the Functions SDK manages routing and lifecycle.

**Real GCP vs mocks:** Chose real Pub/Sub and Firestore because the idempotency guarantees (transactional receipts, at-least-once delivery) are only meaningful against real infrastructure.

**Why reasoning is mocked:** Case study says *"You do NOT need to integrate a real LLM."* The mock maps keywords to structured intents deterministically. The important part — schema validation between reasoning and execution — is real.

**Structured logging over console.log:** All log output uses a custom structured logger (`shared/logger.ts`) that emits JSON to stdout/stderr. GCP Cloud Logging automatically parses this format, making logs filterable by `severity`, `handler`, `eventId`, `conversationId`, etc. Plain `console.log` string interpolation would lose this queryability.

**Enriched receipts over minimal tombstones:** Initial receipt documents only stored `{ eventId, processedAt }`. This was insufficient for debugging stuck pipelines. Receipts now include handler name, conversation context, and a `processing` → `completed` status lifecycle, turning them into an operational audit trail.

**Result existence check in executor:** Receipt-based idempotency has a known gap: if a consumer crashes after claiming a receipt but before completing work, the receipt blocks retries. The executor mitigates this by also checking whether an action result already exists for the intent. This defense-in-depth pattern ensures no duplicate execution even in edge cases.

---

## Deployment

A setup script handles all GCP resource creation, function deployment, and dead letter configuration:

```bash
# Prerequisites: Node.js 20+, gcloud CLI, GCP project with billing
npm install
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The script (`scripts/setup.sh`) performs these steps:
1. Enables required GCP APIs
2. Creates Firestore database (europe-west1)
3. Creates Pub/Sub topics (main + dead letter)
4. Builds and deploys all 3 Cloud Functions
5. Configures dead letter policies (max 5 attempts) on Eventarc subscriptions
6. Creates pull subscriptions on dead letter topics (7-day retention)
7. Grants IAM permissions for Pub/Sub dead letter forwarding

Alternatively, deploy functions individually:
```bash
npm run build
npm run deploy:api
npm run deploy:reasoner
npm run deploy:executor
```

---

## Live Test Results (2026-02-18)

```bash
# Health check
GET /health → { "status": "ok" }

# Send message → full pipeline
POST /messages { "content": "search for AI agent architectures" }
→ 201 { "state": "REASONING_REQUESTED", "conversationId": "27965fb9-..." }

# After ~8s
GET /conversations/27965fb9-... → { "state": "ACTION_COMPLETED" }  ✓

# Idempotency test (same key twice)
POST /messages + X-Idempotency-Key: "idem-test-648176759"
→ 1st: 201 { "messageId": "021bd668-..." }
→ 2nd: 200 { "messageId": "021bd668-...", "duplicate": true }  ✓

# Bad request
POST /messages {} → 400 { "error": "Missing or invalid \"content\" field" }  ✓
```

All action types tested (search, calculate, translate) — all reached `ACTION_COMPLETED`.

---

## AI Tool Usage

**Tool:** Claude (GitHub Copilot in VS Code), used throughout the entire session.

**How it helped:**
- **Architecture decisions** — Discussed Cloud Run vs Cloud Functions trade-offs, analyzed over-engineering risks
- **Code generation** — Generated all functions, shared layer, state machine, Zod schemas. Each file reviewed before accepting
- **Refactoring** — Migrated the codebase from Cloud Run containers to Cloud Functions (removed Dockerfile, Express boilerplate, local runner)
- **Debugging** — Diagnosed Firestore `undefined` rejection and Cloud Build TypeScript issues during deployment
- **Hardening** — Identified race condition in client idempotency (non-transactional read-then-write), removed dead `retryCount` code, configured dead letter queues
- **Observability** — Replaced all console.log calls with structured JSON logger, enriched receipt documents with handler/status/timestamps for debugging
- **Defense-in-depth** — Added executor result existence check to complement receipt-based idempotency
- **Testing** — Executed live end-to-end tests and captured results

**What I manually verified:**
- Full pipeline completion: POST /messages returns 201, conversation reaches `ACTION_COMPLETED` within seconds
- Idempotency: sending the same `X-Idempotency-Key` twice returns the original `messageId` with `duplicate: true`
- Input validation: empty body returns 400 with a clear error message
- Multiple action types (search, calculate, translate) all complete successfully
- Conversation state is queryable via GET /conversations/:id after pipeline finishes
- Dead letter subscriptions exist and are pullable via `gcloud pubsub subscriptions pull`

---

## Changelog

Key changes made during iterative review, with rationale:

| Change | File(s) | Why |
|--------|---------|-----|
| Transactional client idempotency | `firestore.ts`, `api.ts` | Original `findByIdempotencyKey()` + `saveIdempotencyKey()` was a read-then-write — two concurrent requests with the same key could both pass the check (TOCTOU race). Replaced with a single `claimIdempotencyKey()` inside a Firestore transaction. |
| Removed `retryCount` field | `types.ts`, `reasoner.ts`, `executor.ts` | `retryCount` was always set to `0` and never incremented. The `MAX_RETRIES` check was dead code because Pub/Sub redelivers the same payload (it doesn’t increment a counter). Retry policy is now fully delegated to Pub/Sub’s built-in mechanism. |
| Dead letter queues | GCP infra, `scripts/setup.sh` | Without DLQ, a permanently failing message would retry indefinitely (or be silently dropped after ack deadline). Added dead letter topics with max 5 delivery attempts and pull subscriptions for inspection. |
| Enriched receipt documents | `firestore.ts` | Original receipts only stored `{ eventId, processedAt }` — insufficient for debugging. Added `handler`, `conversationId`, `messageId`, `status` lifecycle (`processing` → `completed`), `claimedAt`/`completedAt`. Receipts now serve as an operational audit trail. |
| Stuck receipt recovery | `firestore.ts` | If a consumer crashed after `claimReceipt()` but before `completeReceipt()`, the receipt blocked all retries forever. Now, receipts in `processing` status older than 2 minutes are treated as stale and reclaimed, allowing Pub/Sub retries to succeed. |
| `completeReceipt` merge safety | `firestore.ts` | Changed from `update()` to `set({ merge: true })`. If the receipt doc was somehow lost (partial Firestore failure), `update()` would throw, causing a Pub/Sub retry that could lead to double side-effects. `set({ merge: true })` is idempotent regardless. |
| Executor result existence check | `firestore.ts`, `executor.ts` | Defense-in-depth: even if receipt-based checks are bypassed (edge case), the executor checks if an action result already exists for the `intentId` before executing. Prevents duplicate tool execution. |
| Structured JSON logging | `logger.ts`, all functions, `pubsub.ts` | Replaced all `console.log` string interpolation with a structured logger emitting JSON to stdout/stderr. GCP Cloud Logging parses this natively, enabling filtering by `severity`, `handler`, `eventId`, `conversationId`. |
| Setup script | `scripts/setup.sh` | Previously, infrastructure setup was manual gcloud commands spread across README. Consolidated into a single idempotent script that handles APIs, Firestore, Pub/Sub topics, function deployment, DLQ configuration, and IAM bindings. |
| Cloud Run clarification | `README.md` | Added explicit note that Cloud Functions 2nd gen runs on Cloud Run under the hood, sharing the same stateless container constraints. |
