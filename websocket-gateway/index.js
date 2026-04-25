const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ANALYTICS_COLLECTION = process.env.ANALYTICS_COLLECTION || "movie-stats";
const TOP_MOVIES_LIMIT = Number(process.env.TOP_MOVIES_LIMIT || 10);
const BACKPRESSURE_ENABLED = process.env.BACKPRESSURE_ENABLED !== "false";
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 1000);

const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS === "true";

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const firestore = new Firestore();

const clients = new Set();
const topMoviesById = new Map();

let connectedClients = 0;
let recentActivity = [];
let latencySamples = [];
let totalUpdates = 0;
let totalBroadcasts = 0;
let coalescedUpdates = 0;
let pendingBroadcast = null;
let broadcastTimer = null;
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
  totalBroadcasts,
  coalescedUpdates,
  connectedClients,
  sampleCount: sorted.length,
  latestLatencyMs: sorted.length ? latencySamples[latencySamples.length - 1] : null,
  p50LatencyMs: percentile(sorted, 50),
  p95LatencyMs: percentile(sorted, 95),
  p99LatencyMs: percentile(sorted, 99),
  backpressureEnabled: BACKPRESSURE_ENABLED,
  broadcastIntervalMs: BROADCAST_INTERVAL_MS
};
}

function updateTopMoviesCache(movie) {
  if (!movie || !movie.movieId) {
    return;
  }

  const current = topMoviesById.get(movie.movieId);
  const incomingViewCount = movie.viewCount ?? 0;
  const currentViewCount = current?.viewCount ?? 0;

  if (current && incomingViewCount < currentViewCount) {
    return;
  }

  topMoviesById.set(movie.movieId, {
    movieId: movie.movieId,
    movieTitle: movie.movieTitle || current?.movieTitle || "Unknown movie",
    viewCount: incomingViewCount,
    lastViewed: movie.lastViewed || movie.accessedAt || current?.lastViewed || null,
    updatedAt: movie.processedAt || movie.updatedAt || current?.updatedAt || null
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

    if (!topMovies.length) {
      return getTopMoviesFromMemory(limit);
    }

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

function resetRuntimeState() {
  recentActivity = [];
  latencySamples = [];
  totalUpdates = 0;
  totalBroadcasts = 0;
  coalescedUpdates = 0;
  pendingBroadcast = null;
  lastProcessedUpdate = null;

  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
}

function scheduleBroadcast(payload) {
  if (!BACKPRESSURE_ENABLED) {
    totalBroadcasts += 1;
    broadcast(payload);
    return;
  }

  if (pendingBroadcast) {
    coalescedUpdates += 1;
  }

  pendingBroadcast = payload;

  if (broadcastTimer) {
    return;
  }

  broadcastTimer = setTimeout(() => {
    if (pendingBroadcast) {
      totalBroadcasts += 1;
      broadcast({
        ...pendingBroadcast,
        metrics: buildMetrics()
      });
      pendingBroadcast = null;
    }

    broadcastTimer = null;
  }, BROADCAST_INTERVAL_MS);
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


app.post("/debug/reset", async (req, res) => {
  if (!ENABLE_DEBUG_ENDPOINTS) {
    return res.status(404).json({ error: "Debug endpoints are disabled" });
  }

  resetRuntimeState();

  const topMovies = await fetchTopMovies();
  const metrics = buildMetrics();

  broadcast({
    type: "debug_reset",
    connectedClients,
    recentActivity,
    lastProcessedUpdate,
    topMovies,
    metrics
  });

  res.json({
    status: "reset",
    connectedClients,
    topMovies,
    metrics
  });
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

    scheduleBroadcast({
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