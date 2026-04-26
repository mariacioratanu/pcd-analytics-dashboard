import crypto from 'crypto';
import { PubSub } from '@google-cloud/pubsub';

type ResourceViewedEvent = {
  eventId: string;
  event: 'movie_viewed';
  movieId: string;
  movieTitle: string;
  accessedAt: string;
  viewedAt: string;
  source: 'fast-lazy-bee';
};

let pubsubClient: PubSub | undefined;

const getPubSubClient = (): PubSub => {
  if (pubsubClient === undefined) {
    pubsubClient = new PubSub();
  }

  return pubsubClient;
};

const isResourceEventsEnabled = (): boolean => process.env.ENABLE_RESOURCE_EVENTS === 'true';

export const publishMovieViewedEvent = async (
  movieId: string,
  movieTitle: string
): Promise<void> => {
  if (!isResourceEventsEnabled()) {
    return;
  }

  const topicName = process.env.RESOURCE_EVENTS_TOPIC || 'resource-events';
  const accessedAt = new Date().toISOString();
  const eventId = crypto.randomUUID();

  const payload: ResourceViewedEvent = {
    eventId,
    event: 'movie_viewed',
    movieId,
    movieTitle,
    accessedAt,
    viewedAt: accessedAt,
    source: 'fast-lazy-bee'
  };

  const dataBuffer = Buffer.from(JSON.stringify(payload));

  await getPubSubClient()
    .topic(topicName)
    .publishMessage({
      data: dataBuffer,
      attributes: {
        event: payload.event,
        source: payload.source,
        movieId
      }
    });
};
