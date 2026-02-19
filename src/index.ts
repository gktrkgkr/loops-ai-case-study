/**
 * Cloud Functions entry point.
 *
 * Registers all three functions for GCP Cloud Functions 2nd gen deployment:
 * - api:      HTTP trigger  – accepts user messages
 * - reasoner: Pub/Sub trigger (reasoning-requested topic) – simulates LLM reasoning
 * - executor: Pub/Sub trigger (action-requested topic) – executes tool calls
 *
 * Each function is independently deployable via:
 *   gcloud functions deploy <name> --gen2 --runtime nodejs20 ...
 */

import './functions/api';
import './functions/reasoner';
import './functions/executor';
