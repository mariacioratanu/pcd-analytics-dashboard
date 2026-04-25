const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ANALYTICS_COLLECTION = process.env.ANALYTICS_COLLECTION || "movie-stats";
const TOP_MOVIES_LIMIT = Number(process.env.TOP_MOVIES_LIMIT || 10);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const firestore = new Firestore();

const clients = new Set();
const topMoviesById = new Map();

let connectedClients = 0;
let recentActivity = [];
let latencySamples = [];
let totalUpdates = 0;
let lastProcessedUpdate = null;

function toMillis(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) {
    return null;
  }

  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  const safeIndex = Math.min(Math.max(index, 0), sortedValues.length - 1);
  return sortedValues[safeIndex];
}

function buildMetrics() {
  const sorted = [...latencySamples].sort((a, b) => a - b);

  return {
    totalUpdates,
    connectedClients,
    sampleCount: sorted.length,
    latestLatencyMs: sorted.length ? latencySamples[latencySamples.length - 1] : null,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99)
  };
}

function updateTopMoviesCache(movie) {
  if (!movie || !movie.movieId) {
    return;
  }

  topMoviesById.set(movie.movieId, {
    movieId: movie.movieId,
    movieTitle: movie.movieTitle || "Unknown movie",
    viewCount: movie.viewCount ?? 0,
    lastViewed: movie.lastViewed || movie.accessedAt || null,
    updatedAt: movie.processedAt || movie.updatedAt || null
  });
}

function getTopMoviesFromMemory(limit = TOP_MOVIES_LIMIT) {
  return [...topMoviesById.values()]
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
    .slice(0, limit);
}

async function fetchTopMovies(limit = TOP_MOVIES_LIMIT) {
  try {
    const snapshot = await firestore
      .collection(ANALYTICS_COLLECTION)
      .orderBy("viewCount", "desc")
      .limit(limit)
      .get();

    const topMovies = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      const movie = {
        movieId: data.movieId || doc.id,
        movieTitle: data.movieTitle || "Unknown movie",
        viewCount: data.viewCount ?? 0,
        lastViewed: data.lastViewed || null,
        updatedAt: data.updatedAt || data.lastProcessedAt || null
      };

      topMovies.push(movie);
      updateTopMoviesCache(movie);
    });

    return topMovies;
  } catch (error) {
    console.error(JSON.stringify({ msg: "Failed to fetch top movies", error: error.message }));
    return getTopMoviesFromMemory(limit);
  }
}

async function buildSnapshot() {
  const topMovies = await fetchTopMovies();

  return {
    connectedClients,
    recentActivity,
    lastProcessedUpdate,
    topMovies,
    metrics: buildMetrics()
  };
}

function broadcast(payload) {
  const message = JSON.stringify(payload);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  connectedClients = clients.size;

  buildSnapshot()
    .then((snapshot) => {
      ws.send(JSON.stringify({
        type: "connection_ack",
        ...snapshot
      }));

      broadcast({
        type: "clients_count",
        connectedClients,
        metrics: buildMetrics()
      });
    })
    .catch((error) => {
      console.error(JSON.stringify({ msg: "Failed to send initial snapshot", error: error.message }));
      ws.send(JSON.stringify({
        type: "connection_ack",
        connectedClients,
        recentActivity,
        lastProcessedUpdate,
        topMovies: getTopMoviesFromMemory(),
        metrics: buildMetrics()
      }));
    });

  ws.on("close", () => {
    clients.delete(ws);
    connectedClients = clients.size;

    broadcast({
      type: "clients_count",
      connectedClients,
      metrics: buildMetrics()
    });
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "websocket-gateway", connectedClients });
});

app.get("/snapshot", async (req, res) => {
  try {
    const snapshot = await buildSnapshot();
    res.json(snapshot);
  } catch (error) {
    console.error(JSON.stringify({ msg: "Failed to build snapshot", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

app.get("/top-movies", async (req, res) => {
  try {
    const topMovies = await fetchTopMovies();
    res.json({ topMovies, count: topMovies.length });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Failed to fetch top movies", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

app.post("/pubsub/push", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message || !message.data) {
      return res.status(400).json({ error: "No Pub/Sub message received" });
    }

    const payload = JSON.parse(Buffer.from(message.data, "base64").toString());
    const gatewayReceivedAt = new Date().toISOString();

    const accessedAtMs = toMillis(payload.accessedAt || payload.lastViewed);
    const processedAtMs = toMillis(payload.processedAt);
    const gatewayReceivedAtMs = toMillis(gatewayReceivedAt);

    const processingLatencyMs =
      typeof payload.processingLatencyMs === "number"
        ? payload.processingLatencyMs
        : accessedAtMs !== null && processedAtMs !== null && processedAtMs >= accessedAtMs
          ? processedAtMs - accessedAtMs
          : null;

    const gatewayLatencyMs =
      processedAtMs !== null && gatewayReceivedAtMs !== null && gatewayReceivedAtMs >= processedAtMs
        ? gatewayReceivedAtMs - processedAtMs
        : null;

    const endToEndLatencyMs =
      accessedAtMs !== null && gatewayReceivedAtMs !== null && gatewayReceivedAtMs >= accessedAtMs
        ? gatewayReceivedAtMs - accessedAtMs
        : null;

    const enrichedPayload = {
      ...payload,
      gatewayReceivedAt,
      processingLatencyMs,
      gatewayLatencyMs,
      endToEndLatencyMs
    };

    totalUpdates += 1;
    lastProcessedUpdate = enrichedPayload;

    if (
      typeof endToEndLatencyMs === "number" &&
      Number.isFinite(endToEndLatencyMs) &&
      endToEndLatencyMs >= 0
    ) {
      latencySamples.push(endToEndLatencyMs);
      latencySamples = latencySamples.slice(-200);
    }

    recentActivity.unshift(enrichedPayload);
    recentActivity = recentActivity.slice(0, 20);

    updateTopMoviesCache(enrichedPayload);

    const topMovies = await fetchTopMovies();
    const metrics = buildMetrics();

    broadcast({
      type: "dashboard_update",
      connectedClients,
      payload: enrichedPayload,
      recentActivity,
      lastProcessedUpdate,
      topMovies,
      metrics
    });

    res.status(200).json({ status: "broadcasted", metrics, topMoviesCount: topMovies.length });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Error handling dashboard update", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket gateway running on port ${PORT}`);
});