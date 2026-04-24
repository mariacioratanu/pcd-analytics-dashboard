const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Set();
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

  ws.send(JSON.stringify({
    type: "connection_ack",
    connectedClients,
    recentActivity,
    lastProcessedUpdate,
    metrics: buildMetrics()
  }));

  broadcast({ type: "clients_count", connectedClients, metrics: buildMetrics() });

  ws.on("close", () => {
    clients.delete(ws);
    connectedClients = clients.size;
    broadcast({ type: "clients_count", connectedClients, metrics: buildMetrics() });
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "websocket-gateway", connectedClients });
});

app.get("/snapshot", (req, res) => {
  res.json({ connectedClients, recentActivity, lastProcessedUpdate, metrics: buildMetrics() });
});

app.post("/pubsub/push", (req, res) => {
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

    const processingLatencyMs = typeof payload.processingLatencyMs === "number" ? payload.processingLatencyMs : accessedAtMs !== null && processedAtMs !== null && processedAtMs >= accessedAtMs ? processedAtMs - accessedAtMs : null;
    const gatewayLatencyMs = processedAtMs !== null && gatewayReceivedAtMs !== null && gatewayReceivedAtMs >= processedAtMs ? gatewayReceivedAtMs - processedAtMs : null;
    const endToEndLatencyMs = accessedAtMs !== null && gatewayReceivedAtMs !== null && gatewayReceivedAtMs >= accessedAtMs ? gatewayReceivedAtMs - accessedAtMs : null;

    const enrichedPayload = {
      ...payload,
      gatewayReceivedAt,
      processingLatencyMs,
      gatewayLatencyMs,
      endToEndLatencyMs
    };

    totalUpdates += 1;
    lastProcessedUpdate = enrichedPayload;

    if (typeof endToEndLatencyMs === "number" && Number.isFinite(endToEndLatencyMs) && endToEndLatencyMs >= 0) {
      latencySamples.push(endToEndLatencyMs);
      latencySamples = latencySamples.slice(-200);
    }

    recentActivity.unshift(enrichedPayload);
    recentActivity = recentActivity.slice(0, 20);

    const metrics = buildMetrics();

    broadcast({
      type: "dashboard_update",
      connectedClients,
      payload: enrichedPayload,
      recentActivity,
      lastProcessedUpdate,
      metrics
    });

    res.status(200).json({ status: "broadcasted", metrics });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Error handling dashboard update", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket gateway running on port ${PORT}`);
});
