const statusEl = document.getElementById("status");
const clientsEl = document.getElementById("clients");
const activityEl = document.getElementById("activity");
const latencyMetricsEl = document.getElementById("latency-metrics");
const gatewayUrlEl = document.getElementById("gateway-url");

const totalUpdatesEl = document.getElementById("metric-total-updates");
const latestLatencyEl = document.getElementById("metric-latest-latency");
const p50El = document.getElementById("metric-p50");
const p95El = document.getElementById("metric-p95");
const p99El = document.getElementById("metric-p99");
const samplesEl = document.getElementById("metric-samples");

const params = new URLSearchParams(window.location.search);
let gatewayUrl = params.get("ws") || params.get("gateway") || localStorage.getItem("gatewayUrl") || "ws://localhost:8080";

gatewayUrl = gatewayUrl.trim();
if (gatewayUrl.startsWith("https://")) {
  gatewayUrl = "wss://" + gatewayUrl.slice("https://".length);
}
if (gatewayUrl.startsWith("http://")) {
  gatewayUrl = "ws://" + gatewayUrl.slice("http://".length);
}

localStorage.setItem("gatewayUrl", gatewayUrl);
gatewayUrlEl.textContent = gatewayUrl;

function formatMetric(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function renderMetrics(metrics) {
  if (!metrics) {
    totalUpdatesEl.textContent = "0";
    latestLatencyEl.textContent = "-";
    p50El.textContent = "-";
    p95El.textContent = "-";
    p99El.textContent = "-";
    samplesEl.textContent = "0";
    return;
  }

  totalUpdatesEl.textContent = formatMetric(metrics.totalUpdates);
  latestLatencyEl.textContent = formatMetric(metrics.latestLatencyMs);
  p50El.textContent = formatMetric(metrics.p50LatencyMs);
  p95El.textContent = formatMetric(metrics.p95LatencyMs);
  p99El.textContent = formatMetric(metrics.p99LatencyMs);
  samplesEl.textContent = formatMetric(metrics.sampleCount);
}

function renderActivity(items) {
  activityEl.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "No activity yet.";
    activityEl.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    const title = item.movieTitle || item.movieId || "Unknown movie";
    const count = item.viewCount ?? "?";
    const when = item.processedAt || item.lastViewed || "-";
    const latency = item.endToEndLatencyMs ?? "-";
    li.textContent = `${title} | views=${count} | processedAt=${when} | e2eLatencyMs=${latency}`;
    activityEl.appendChild(li);
  });
}

function renderLastUpdate(payload) {
  latencyMetricsEl.innerHTML = "";

  if (!payload) {
    const li = document.createElement("li");
    li.textContent = "No processed update yet.";
    latencyMetricsEl.appendChild(li);
    return;
  }

  const li = document.createElement("li");
  li.textContent = `${payload.movieTitle || payload.movieId} | views=${payload.viewCount ?? "?"} | processedAt=${payload.processedAt || "-"} | processingLatencyMs=${payload.processingLatencyMs ?? "-"} | gatewayLatencyMs=${payload.gatewayLatencyMs ?? "-"} | endToEndLatencyMs=${payload.endToEndLatencyMs ?? "-"}`;
  latencyMetricsEl.appendChild(li);
}

statusEl.textContent = "connecting";
renderActivity([]);
renderLastUpdate(null);
renderMetrics(null);

const socket = new WebSocket(gatewayUrl);

socket.addEventListener("open", () => {
  statusEl.textContent = "connected";
});

socket.addEventListener("close", () => {
  statusEl.textContent = "disconnected";
});

socket.addEventListener("error", () => {
  statusEl.textContent = "error";
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (typeof message.connectedClients === "number") {
    clientsEl.textContent = message.connectedClients;
  }

  if (message.metrics) {
    renderMetrics(message.metrics);
  }

  if (Array.isArray(message.recentActivity)) {
    renderActivity(message.recentActivity);
  }

  if (message.lastProcessedUpdate || message.payload) {
    renderLastUpdate(message.lastProcessedUpdate || message.payload);
  } else if (Array.isArray(message.recentActivity) && message.recentActivity.length > 0) {
    renderLastUpdate(message.recentActivity[0]);
  }
});
