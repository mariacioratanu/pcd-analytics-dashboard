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

exports.processResourceEvent = async (cloudEvent) => {
  const message = cloudEvent.data && cloudEvent.data.message ? cloudEvent.data.message : cloudEvent.data;
  if (!message || !message.data) {
    console.log(JSON.stringify({ msg: "No Pub/Sub payload received" }));
    return;
  }

  const messageId = message.messageId || "unknown-message-id";
  const payload = JSON.parse(Buffer.from(message.data, "base64").toString());
  const processedRef = firestore.collection(PROCESSED_COLLECTION).doc(messageId);
  const processedDoc = await processedRef.get();

  if (processedDoc.exists) {
    console.log(JSON.stringify({ msg: "Duplicate message skipped", messageId }));
    return;
  }

  const movieId = payload.movieId || "unknown-movie";
  const movieTitle = payload.movieTitle || "Unknown";
  const statsRef = firestore.collection(ANALYTICS_COLLECTION).doc(movieId);
  const now = new Date().toISOString();

  await firestore.runTransaction(async (tx) => {
    const existingStats = await tx.get(statsRef);
    const alreadyProcessed = await tx.get(processedRef);

    if (alreadyProcessed.exists) {
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

  console.log(JSON.stringify({ msg: "Event processed", messageId, movieId, viewCount: stats.viewCount }));
};
