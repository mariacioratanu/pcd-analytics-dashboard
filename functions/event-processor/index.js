const crypto = require("crypto");
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

function extractBase64Data(cloudEvent) {
  const raw = cloudEvent?.data;

  if (typeof raw === "string") {
    return { base64Data: raw, messageId: cloudEvent?.id || null, rawType: "string" };
  }

  if (raw?.message?.data) {
    return { base64Data: raw.message.data, messageId: raw.message.messageId || cloudEvent?.id || null, rawType: "message.data" };
  }

  if (raw?.data) {
    return { base64Data: raw.data, messageId: raw.messageId || cloudEvent?.id || null, rawType: "data" };
  }

  return { base64Data: null, messageId: cloudEvent?.id || null, rawType: typeof raw };
}

function parseLooseObjectString(decoded) {
  const trimmed = decoded.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Decoded payload is neither valid JSON nor loose object format");
  }

  const inner = trimmed.slice(1, -1);
  const parts = inner.split(/,(?=[a-zA-Z_][a-zA-Z0-9_]*:)/);
  const obj = {};

  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) {
      continue;
    }

    const key = part.slice(0, idx).trim().replace(/^"|"$/g, "");
    const value = part.slice(idx + 1).trim().replace(/^"|"$/g, "");
    obj[key] = value;
  }

  return obj;
}

function decodePayload(base64Data) {
  const decoded = Buffer.from(base64Data, "base64").toString();

  try {
    return JSON.parse(decoded);
  } catch {
    return parseLooseObjectString(decoded);
  }
}

function buildFallbackMessageId(base64Data) {
  return crypto.createHash("sha256").update(base64Data).digest("hex");
}

function toMillis(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

exports.processResourceEvent = async (cloudEvent) => {
  const { base64Data, messageId: rawMessageId, rawType } = extractBase64Data(cloudEvent);

  console.log(JSON.stringify({
    msg: "Received cloud event",
    cloudEventId: cloudEvent?.id,
    cloudEventType: cloudEvent?.type,
    rawType,
    hasBase64Data: Boolean(base64Data)
  }));

  if (!base64Data) {
    console.error(JSON.stringify({
      msg: "No Pub/Sub payload received",
      cloudEventId: cloudEvent?.id,
      cloudEventType: cloudEvent?.type
    }));
    throw new Error("No Pub/Sub payload received");
  }

const payload = decodePayload(base64Data);
const eventId = payload.eventId || rawMessageId || buildFallbackMessageId(base64Data);
const messageId = rawMessageId || eventId;
const movieId = payload.movieId || "unknown-movie";
  const movieTitle = payload.movieTitle || "Unknown";
  const accessedAt = payload.accessedAt || payload.viewedAt || new Date().toISOString();
  const processedAt = new Date().toISOString();
  const accessedAtMs = toMillis(accessedAt);
  const processedAtMs = toMillis(processedAt);
  const processingLatencyMs = accessedAtMs !== null && processedAtMs !== null && processedAtMs >= accessedAtMs ? processedAtMs - accessedAtMs : null;
  const statsRef = firestore.collection(ANALYTICS_COLLECTION).doc(movieId);
  const processedRef = firestore.collection(PROCESSED_COLLECTION).doc(messageId);
  let duplicate = false;

  await firestore.runTransaction(async (tx) => {
    const existingStats = await tx.get(statsRef);
    const alreadyProcessed = await tx.get(processedRef);

    if (alreadyProcessed.exists) {
      duplicate = true;
      return;
    }

    if (existingStats.exists) {
      tx.update(statsRef, {
        movieId,
        movieTitle,
        viewCount: FieldValue.increment(1),
        lastViewed: accessedAt,
        lastProcessedAt: processedAt,
        updatedAt: processedAt
      });
    } else {
      tx.set(statsRef, {
        movieId,
        movieTitle,
        viewCount: 1,
        lastViewed: accessedAt,
        lastProcessedAt: processedAt,
        createdAt: processedAt,
        updatedAt: processedAt
      });
    }

    tx.set(processedRef, {
  eventId,
  messageId,
  processedAt,
  movieId
});
  });

  if (duplicate) {
    console.log(JSON.stringify({ msg: "Duplicate message skipped", messageId, movieId }));
    return;
  }

  const updatedDoc = await statsRef.get();
  const stats = updatedDoc.data();

const dashboardPayload = {
  type: "movie_viewed_processed",
  eventId,
  messageId,
  movieId: stats.movieId,
    movieTitle: stats.movieTitle,
    viewCount: stats.viewCount,
    accessedAt,
    lastViewed: stats.lastViewed || accessedAt,
    processedAt,
    processingLatencyMs
  };

  try {
    await publishDashboardUpdate(dashboardPayload);
  } catch (error) {
    console.error(JSON.stringify({
      msg: "Failed to publish dashboard update",
      movieId,
      error: error.message
    }));
  }

  console.log(JSON.stringify({
  msg: "Event processed",
  eventId,
  messageId,
  movieId,
  viewCount: stats.viewCount,
  processingLatencyMs
}));
};
