import { PubSub } from "@google-cloud/pubsub";

type ResourceViewedEvent = {
  event: "movie_viewed";
  movieId: string;
  movieTitle: string;
  viewedAt: string;
  source: "fast-lazy-bee";
};

let pubsubClient: PubSub | undefined;

const getPubSubClient = (): PubSub => {
  if (pubsubClient === undefined) {
    pubsubClient = new PubSub();
  }

  return pubsubClient;
};

const isResourceEventsEnabled = (): boolean => process.env.ENABLE_RESOURCE_EVENTS === "true";

export const publishMovieViewedEvent = async (movieId: string, movieTitle: string): Promise<void> => {
  if (!isResourceEventsEnabled()) {
    return;
  }

  const topicName = process.env.RESOURCE_EVENTS_TOPIC || "resource-events";
  const payload: ResourceViewedEvent = {
    event: "movie_viewed",
    movieId,
    movieTitle,
    viewedAt: new Date().toISOString(),
    source: "fast-lazy-bee"
  };

  const dataBuffer = Buffer.from(JSON.stringify(payload));
  await getPubSubClient().topic(topicName).publishMessage({ data: dataBuffer });
};
