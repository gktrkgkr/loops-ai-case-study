#!/usr/bin/env bash
#
# Loops AI Case Study – GCP Infrastructure Setup
#
# Creates all required GCP resources:
#   - Firestore database
#   - Pub/Sub topics (main + dead letter)
#   - Dead letter subscriptions (pull, 7-day retention)
#   - Dead letter IAM bindings
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - GCP project with billing enabled
#
# Usage:
#   chmod +x scripts/setup.sh
#   ./scripts/setup.sh

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-loops-case-study-487816}"
REGION="europe-west1"

echo "=== Loops AI – GCP Setup ==="
echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo ""

# ── Enable APIs ─────────────────────────────────────────────
echo "[1/6] Enabling APIs..."
gcloud services enable \
  cloudfunctions.googleapis.com \
  pubsub.googleapis.com \
  firestore.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  eventarc.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

# ── Firestore ──────────────────────────────────────────────
echo "[2/6] Creating Firestore database..."
gcloud firestore databases create \
  --location="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null || echo "  (already exists)"

# ── Pub/Sub Topics ─────────────────────────────────────────
echo "[3/6] Creating Pub/Sub topics..."
for TOPIC in reasoning-requested action-requested reasoning-dead-letter action-dead-letter; do
  gcloud pubsub topics create "$TOPIC" \
    --project="$PROJECT_ID" 2>/dev/null || echo "  $TOPIC (already exists)"
done

# ── Dead Letter Pull Subscriptions ─────────────────────────
echo "[4/6] Creating dead letter pull subscriptions..."
for PAIR in "reasoning-dead-letter:reasoning-dead-letter-sub" "action-dead-letter:action-dead-letter-sub"; do
  TOPIC="${PAIR%%:*}"
  SUB="${PAIR##*:}"
  gcloud pubsub subscriptions create "$SUB" \
    --topic="$TOPIC" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    --project="$PROJECT_ID" 2>/dev/null || echo "  $SUB (already exists)"
done

# ── Deploy Functions ───────────────────────────────────────
echo "[5/6] Building and deploying Cloud Functions..."
npm run build
npm run deploy:all

# ── Dead Letter Policy on Eventarc Subscriptions ───────────
echo "[6/6] Configuring dead letter policies..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
PUBSUB_SA="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# Find Eventarc-created subscriptions
REASONER_SUB=$(gcloud pubsub subscriptions list \
  --filter="topic:reasoning-requested AND NOT topic:dead-letter" \
  --format="value(name)" \
  --project="$PROJECT_ID" | head -1 | xargs basename)

EXECUTOR_SUB=$(gcloud pubsub subscriptions list \
  --filter="topic:action-requested AND NOT topic:dead-letter" \
  --format="value(name)" \
  --project="$PROJECT_ID" | head -1 | xargs basename)

# Apply dead letter policy (max 5 attempts)
for PAIR in "$REASONER_SUB:reasoning-dead-letter" "$EXECUTOR_SUB:action-dead-letter"; do
  SUB="${PAIR%%:*}"
  DLT="${PAIR##*:}"
  gcloud pubsub subscriptions update "$SUB" \
    --dead-letter-topic="$DLT" \
    --max-delivery-attempts=5 \
    --project="$PROJECT_ID"
done

# Grant Pub/Sub SA permissions for dead letter forwarding
for TOPIC in reasoning-dead-letter action-dead-letter; do
  gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
    --member="$PUBSUB_SA" \
    --role="roles/pubsub.publisher" \
    --project="$PROJECT_ID"
done

for SUB in "$REASONER_SUB" "$EXECUTOR_SUB"; do
  gcloud pubsub subscriptions add-iam-policy-binding "$SUB" \
    --member="$PUBSUB_SA" \
    --role="roles/pubsub.subscriber" \
    --project="$PROJECT_ID"
done

echo ""
echo "=== Setup complete ==="
echo "API: https://${REGION}-${PROJECT_ID}.cloudfunctions.net/api"
