/**
 * Pub/Sub utilities.
 *
 * Provides publish functionality and type definitions for
 * Cloud Functions 2nd gen Pub/Sub event triggers.
 */

import { PubSub, Topic } from '@google-cloud/pubsub';
import { AgentEvent } from './types';
import { log } from './logger';

let client: PubSub;

function getPubSub(): PubSub {
  if (!client) {
    client = new PubSub();
  }
  return client;
}

const topicCache = new Map<string, Topic>();

function getTopic(name: string): Topic {
  if (!topicCache.has(name)) {
    topicCache.set(name, getPubSub().topic(name));
  }
  return topicCache.get(name)!;
}

/**
 * Publish an AgentEvent to the given Pub/Sub topic.
 * The event is JSON-encoded into the message data field.
 */
export async function publishEvent(
  topicName: string,
  event: AgentEvent,
): Promise<string> {
  const topic = getTopic(topicName);
  const messageId = await topic.publishMessage({
    data: Buffer.from(JSON.stringify(event)),
    attributes: {
      eventId: event.eventId,
      eventType: event.eventType,
      conversationId: event.conversationId,
    },
  });
  log.info('Published event', {
    handler: 'pubsub',
    eventId: event.eventId,
    eventType: event.eventType,
    conversationId: event.conversationId,
    topic: topicName,
    pubsubMessageId: messageId,
  });
  return messageId;
}

/**
 * Pub/Sub message structure received by Cloud Functions 2nd gen
 * via Eventarc Pub/Sub triggers (CloudEvent envelope).
 */
export interface MessagePublishedData {
  message?: {
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

/**
 * Decode a Cloud Functions Pub/Sub CloudEvent payload into an AgentEvent.
 * The message data field is base64-encoded JSON.
 */
export function decodeEventData(data: MessagePublishedData | undefined): AgentEvent {
  const raw = data?.message?.data;
  if (!raw) throw new Error('Missing Pub/Sub message data in CloudEvent');
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) as AgentEvent;
}
