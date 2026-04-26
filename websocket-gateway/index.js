const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const { Firestore } = require("@google-cloud/firestore");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ANALYTICS_COLLECTION = process.env.ANALYTICS_COLLECTION || "movie-stats";
const TOP_MOVIES_LIMIT = Number(process.env.TOP_MOVIES_LIMIT || 10);
const BACKPRESSURE_ENABLED = process.env.BACKPRESSURE_ENABLED !== "false";
const BROADCAST_INTERVAL_MS = Number(process.env.BROADCAST_INTERVAL_MS || 1000);

const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS === "true";
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";

const ENABLE_GRPC_ANALYTICS = process.env.ENABLE_GRPC_ANALYTICS === "true";
const GRPC_ANALYTICS_TARGET = process.env.GRPC_ANALYTICS_TARGET || "";
const GRPC_DEADLINE_MS = Number(process.env.GRPC_DEADLINE_MS || 2000);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const firestore = new Firestore();

const clients = new Set();
const topMoviesById = new Map();

let connectedClients = 0;
let totalClientConnections = 0;
let totalClientDisconnects = 0;
let recentActivity = [];
let latencySamples = [];
let totalUpdates = 0;
let totalBroadcasts = 0;
let coalescedUpdates = 0;
let pendingBroadcast = null;
let broadcastTimer = null;
let lastProcessedUpdate = null;
let analyticsGrpcClient = null;
let lastTopMoviesSource = "none";
let lastGrpcError = null;

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
    totalClientConnections,
    totalClientDisconnects,
    sampleCount: sorted.length,
    latestLatencyMs: sorted.length ? latencySamples[latencySamples.length - 1] : null,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99),
    backpressureEnabled: BACKPRESSURE_ENABLED,
    broadcastIntervalMs: BROADCAST_INTERVAL_MS
  };
}

function normalizeGrpcTarget(value) {
  if (!value) {
    return { address: "", secure: true };
  }

  const trimmed = String(value).trim();

  if (trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    return {
      address: `${url.hostname}:443`,
      secure: true
    };
  }

  if (trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    return {
      address: `${url.hostname}:${url.port || 80}`,
      secure: false
    };
  }

  const isLocalhost = trimmed.includes("localhost") || trimmed.startsWith("127.0.0.1");

  return {
    address: trimmed,
    secure: !isLocalhost
  };
}

function getAnalyticsGrpcClient() {
  if (!ENABLE_GRPC_ANALYTICS || !GRPC_ANALYTICS_TARGET) {
    return null;
  }

  if (analyticsGrpcClient) {
    return analyticsGrpcClient;
  }

  const protoPath = path.join(__dirname, "proto", "analytics.proto");

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });

  const analyticsProto = grpc.loadPackageDefinition(packageDefinition).analytics;
  const target = normalizeGrpcTarget(GRPC_ANALYTICS_TARGET);
  const credentials = target.secure
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();

  analyticsGrpcClient = new analyticsProto.AnalyticsService(target.address, credentials);

  console.log(JSON.stringify({
    msg: "gRPC analytics client initialized",
    target: target.address,
    secure: target.secure
  }));

  return analyticsGrpcClient;
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

function fetchTopMoviesViaGrpc(limit = TOP_MOVIES_LIMIT) {
  return new Promise((resolve, reject) => {
    const client = getAnalyticsGrpcClient();

    if (!client) {
      reject(new Error("gRPC analytics is disabled or not configured"));
      return;
    }

    const deadline = new Date(Date.now() + GRPC_DEADLINE_MS);

    client.GetTopMovies({ limit }, { deadline }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      const topMovies = (response.movies || []).map((movie) => ({
        movieId: movie.movieId,
        movieTitle: movie.movieTitle || "Unknown movie",
        viewCount: Number(movie.viewCount || 0),
        lastViewed: movie.lastViewed || null,
        updatedAt: movie.updatedAt || null
      }));

      topMovies.forEach(updateTopMoviesCache);

      resolve(topMovies);
    });
  });
}

async function fetchTopMoviesFromFirestore(limit = TOP_MOVIES_LIMIT) {
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
}

async function fetchTopMovies(limit = TOP_MOVIES_LIMIT) {
  if (ENABLE_GRPC_ANALYTICS && GRPC_ANALYTICS_TARGET) {
    try {
      const topMovies = await fetchTopMoviesViaGrpc(limit);

      lastTopMoviesSource = "grpc";
      lastGrpcError = null;

      if (topMovies.length) {
        return topMovies;
      }
    } catch (error) {
      lastGrpcError = error.message;
      console.error(JSON.stringify({
        msg: "Failed to fetch top movies through gRPC, falling back to Firestore",
        error: error.message
      }));
    }
  }

  try {
    const topMovies = await fetchTopMoviesFromFirestore(limit);

    lastTopMoviesSource = "firestore-fallback";

    if (!topMovies.length) {
      lastTopMoviesSource = "memory-fallback";
      return getTopMoviesFromMemory(limit);
    }

    return topMovies;
  } catch (error) {
    lastTopMoviesSource = "memory-fallback";
    console.error(JSON.stringify({
      msg: "Failed to fetch top movies from Firestore, falling back to memory",
      error: error.message
    }));

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

function isDebugRequestAuthorized(req) {
  if (!ENABLE_DEBUG_ENDPOINTS) {
    return { ok: false, status: 404, body: { error: "Debug endpoints are disabled" } };
  }

  if (!DEBUG_TOKEN) {
    return { ok: true };
  }

  const providedToken = req.header("x-debug-token");

  if (providedToken !== DEBUG_TOKEN) {
    return { ok: false, status: 403, body: { error: "Invalid or missing debug token" } };
  }

  return { ok: true };
}

function resetRuntimeState() {
  recentActivity = [];
  latencySamples = [];
  totalUpdates = 0;
  totalBroadcasts = 0;
  coalescedUpdates = 0;
  pendingBroadcast = null;
  lastProcessedUpdate = null;
  lastGrpcError = null;

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
  totalClientConnections += 1;

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
    totalClientDisconnects += 1;
    broadcast({ type: "clients_count", connectedClients, metrics: buildMetrics() });
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "websocket-gateway",
    connectedClients,
    grpcAnalyticsEnabled: ENABLE_GRPC_ANALYTICS,
    grpcAnalyticsConfigured: Boolean(GRPC_ANALYTICS_TARGET)
  });
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

app.get("/metrics", async (req, res) => {
  const topMovies = await fetchTopMovies();
  const metrics = buildMetrics();

  res.json({
    service: "websocket-gateway",
    generatedAt: new Date().toISOString(),
    metrics,
    state: {
      connectedClients,
      recentActivityCount: recentActivity.length,
      topMoviesCount: topMovies.length,
      hasLastProcessedUpdate: lastProcessedUpdate !== null,
      topMoviesSource: lastTopMoviesSource,
      grpcAnalyticsEnabled: ENABLE_GRPC_ANALYTICS,
      grpcAnalyticsTargetConfigured: Boolean(GRPC_ANALYTICS_TARGET),
      lastGrpcError
    }
  });
});

app.get("/top-movies", async (req, res) => {
  try {
    const topMovies = await fetchTopMovies();
    res.json({
      topMovies,
      count: topMovies.length,
      source: lastTopMoviesSource,
      grpcAnalyticsEnabled: ENABLE_GRPC_ANALYTICS,
      lastGrpcError
    });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Failed to fetch top movies", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

app.get("/grpc/top-movies", async (req, res) => {
  try {
    const topMovies = await fetchTopMoviesViaGrpc(TOP_MOVIES_LIMIT);

    res.json({
      topMovies,
      count: topMovies.length,
      source: "grpc",
      grpcAnalyticsEnabled: ENABLE_GRPC_ANALYTICS
    });
  } catch (error) {
    res.status(502).json({
      error: error.message,
      source: "grpc",
      grpcAnalyticsEnabled: ENABLE_GRPC_ANALYTICS,
      grpcAnalyticsConfigured: Boolean(GRPC_ANALYTICS_TARGET)
    });
  }
});

app.post("/debug/reset", async (req, res) => {
  const auth = isDebugRequestAuthorized(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
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
    topMoviesSource: lastTopMoviesSource,
    metrics
  });
});

app.post("/debug/close-clients", (req, res) => {
  const auth = isDebugRequestAuthorized(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  const closedClients = clients.size;

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1012, "Debug reconnect test");
    }
  }

  res.json({
    status: "closing_clients",
    closedClients,
    message: "Connected WebSocket clients were asked to close. Dashboard clients should reconnect automatically."
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

    res.status(200).json({
      status: "broadcasted",
      metrics,
      topMoviesCount: topMovies.length,
      topMoviesSource: lastTopMoviesSource
    });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Error handling dashboard update", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket gateway running on port ${PORT}`);
  console.log(`gRPC analytics enabled=${ENABLE_GRPC_ANALYTICS}`);
  console.log(`gRPC analytics target=${GRPC_ANALYTICS_TARGET || "not configured"}`);
});