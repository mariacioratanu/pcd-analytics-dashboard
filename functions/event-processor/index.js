const { Firestore, FieldValue } = require("@google-cloud/firestore");
const { PubSub } = require("@google-cloud/pubsub");

const firestore = new Firestore();
const pubsub = new PubSub();

const ANALYTICS_COLLECTION = process.env.ANALYTICS_COLLECTION || "movie-stats";
const PROCESSED_COLLECTION = process.env.PROCESSED_COLLECTION || "processed-events";
const DASHBOARD_UPDATES_TOPIC = process.env.DASHBOARD_UPDATES_TOPIC || "dashboard-updates";

async function publishDashboardUpdate(payload) {
  const dataBuffer = Buffer.from(JSON.stringify(payload));
  await pubsub.topic(DASHBOARD_UPDATES_TOPIC).publishMessage({ data: dataBuffer });
}

function normalizeEventData(rawData) {
  if (rawData == null) {
    return {};
  }

  if (typeof rawData === "string") {
    try {
      return JSON.parse(rawData);
    } catch {
      return { raw: rawData };
    }
  }

  return rawData;
}

exports.processResourceEvent = async (cloudEvent) => {
  const rawEventData = cloudEvent?.data;
  const eventData = normalizeEventData(rawEventData);
  const message = eventData?.message ?? eventData;
  const base64Data = message?.data;
  const messageId = message?.messageId ?? message?.message_id ?? cloudEvent?.id ?? "unknown-message-id";

  console.log(JSON.stringify({
    msg: "Received cloud event",
    cloudEventId: cloudEvent?.id,
    cloudEventType: cloudEvent?.type,
    eventDataKeys: eventData && typeof eventData === "object" ? Object.keys(eventData) : [],
    messageKeys: message && typeof message === "object" ? Object.keys(message) : [],
    hasBase64Data: Boolean(base64Data)
  }));

  if (!base64Data) {
    console.error(JSON.stringify({
      msg: "No Pub/Sub payload received",
      cloudEventId: cloudEvent?.id,
      cloudEventType: cloudEvent?.type,
      eventData,
      rawDataType: typeof rawEventData
    }));
    throw new Error("No Pub/Sub payload received");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(base64Data, "base64").toString());
  } catch (error) {
    console.error(JSON.stringify({
      msg: "Failed to decode Pub/Sub payload",
      messageId,
      error: error.message
    }));
    throw error;
  }

  const movieId = payload.movieId || "unknown-movie";
  const movieTitle = payload.movieTitle || "Unknown";
  const statsRef = firestore.collection(ANALYTICS_COLLECTION).doc(movieId);
  const processedRef = firestore.collection(PROCESSED_COLLECTION).doc(messageId);
  const now = new Date().toISOString();

  await firestore.runTransaction(async (tx) => {
    const existingStats = await tx.get(statsRef);
    const alreadyProcessed = await tx.get(processedRef);

    if (alreadyProcessed.exists) {
      console.log(JSON.stringify({ msg: "Duplicate message skipped", messageId, movieId }));
      return;
    }

    if (existingStats.exists) {
      tx.update(statsRef, {
        movieId,
        movieTitle,
        viewCount: FieldValue.increment(1),
        lastViewed: now,
        updatedAt: now
      });
    } else {
      tx.set(statsRef, {
        movieId,
        movieTitle,
        viewCount: 1,
        lastViewed: now,
        createdAt: now,
        updatedAt: now
      });
    }

    tx.set(processedRef, {
      processedAt: now,
      movieId
    });
  });

  const updatedDoc = await statsRef.get();
  const stats = updatedDoc.data();

  await publishDashboardUpdate({
    type: "movie_viewed_processed",
    movieId: stats.movieId,
    movieTitle: stats.movieTitle,
    viewCount: stats.viewCount,
    lastViewed: stats.lastViewed,
    processedAt: now
  });

  console.log(JSON.stringify({
    msg: "Event processed",
    messageId,
    movieId,
    viewCount: stats.viewCount
  }));
};
