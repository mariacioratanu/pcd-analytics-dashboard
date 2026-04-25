const statusEl = document.getElementById("status");
const clientsEl = document.getElementById("clients");
const activityEl = document.getElementById("activity");
const topMoviesEl = document.getElementById("top-movies");
const latencyMetricsEl = document.getElementById("latency-metrics");
const gatewayUrlEl = document.getElementById("gateway-url");

const totalUpdatesEl = document.getElementById("metric-total-updates");
const latestLatencyEl = document.getElementById("metric-latest-latency");
const p50El = document.getElementById("metric-p50");
const p95El = document.getElementById("metric-p95");
const p99El = document.getElementById("metric-p99");
const samplesEl = document.getElementById("metric-samples");

const params = new URLSearchParams(window.location.search);

let gatewayUrl =
  params.get("ws") ||
  params.get("gateway") ||
  localStorage.getItem("gatewayUrl") ||
  "ws://localhost:8080";

gatewayUrl = gatewayUrl.trim();

if (gatewayUrl.startsWith("https://")) {
  gatewayUrl = "wss://" + gatewayUrl.slice("https://".length);
}

if (gatewayUrl.startsWith("http://")) {
  gatewayUrl = "ws://" + gatewayUrl.slice("http://".length);
}

const snapshotUrl = gatewayUrl.startsWith("wss://")
  ? "https://" + gatewayUrl.slice("wss://".length)
  : gatewayUrl.startsWith("ws://")
    ? "http://" + gatewayUrl.slice("ws://".length)
    : gatewayUrl;

localStorage.setItem("gatewayUrl", gatewayUrl);
gatewayUrlEl.textContent = gatewayUrl;

let reconnectTimer = null;
let reconnectAttempt = 0;
let hasRenderedRealData = false;

function formatMetric(value) {
  return value === null || value === undefined ? "-" : String(value);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function setLoadingState() {
  statusEl.textContent = "loading snapshot...";
  clientsEl.textContent = "loading...";

  totalUpdatesEl.textContent = "loading...";
  latestLatencyEl.textContent = "loading...";
  p50El.textContent = "loading...";
  p95El.textContent = "loading...";
  p99El.textContent = "loading...";
  samplesEl.textContent = "loading...";

  topMoviesEl.innerHTML = "";
  const topMoviesLoading = document.createElement("li");
  topMoviesLoading.textContent = "Loading top viewed movies...";
  topMoviesEl.appendChild(topMoviesLoading);

  activityEl.innerHTML = "";
  const activityLoading = document.createElement("li");
  activityLoading.textContent = "Loading recent activity...";
  activityEl.appendChild(activityLoading);

  latencyMetricsEl.innerHTML = "";
  const lastUpdateLoading = document.createElement("li");
  lastUpdateLoading.textContent = "Loading last processed update...";
  latencyMetricsEl.appendChild(lastUpdateLoading);
}

function renderMetrics(metrics) {
  if (!metrics) {
    totalUpdatesEl.textContent = "-";
    latestLatencyEl.textContent = "-";
    p50El.textContent = "-";
    p95El.textContent = "-";
    p99El.textContent = "-";
    samplesEl.textContent = "-";
    return;
  }

  totalUpdatesEl.textContent = formatMetric(metrics.totalUpdates);
  latestLatencyEl.textContent = formatMetric(metrics.latestLatencyMs);
  p50El.textContent = formatMetric(metrics.p50LatencyMs);
  p95El.textContent = formatMetric(metrics.p95LatencyMs);
  p99El.textContent = formatMetric(metrics.p99LatencyMs);
  samplesEl.textContent = formatMetric(metrics.sampleCount);
}

function renderTopMovies(items) {
  topMoviesEl.innerHTML = "";

  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = "No top movies available yet.";
    topMoviesEl.appendChild(li);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    const title = item.movieTitle || item.movieId || "Unknown movie";
    const count = item.viewCount ?? "?";
    const lastViewed = formatDate(item.lastViewed || item.updatedAt);

    li.textContent = `#${index + 1} ${title} | views=${count} | lastViewed=${lastViewed}`;
    topMoviesEl.appendChild(li);
  });
}

function renderActivity(items) {
  activityEl.innerHTML = "";

  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = "No activity yet.";
    activityEl.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    const title = item.movieTitle || item.movieId || "Unknown movie";
    const count = item.viewCount ?? "?";
    const when = formatDate(item.processedAt || item.lastViewed);
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

  li.textContent =
    `${payload.movieTitle || payload.movieId} | ` +
    `views=${payload.viewCount ?? "?"} | ` +
    `processedAt=${formatDate(payload.processedAt)} | ` +
    `processingLatencyMs=${payload.processingLatencyMs ?? "-"} | ` +
    `gatewayLatencyMs=${payload.gatewayLatencyMs ?? "-"} | ` +
    `endToEndLatencyMs=${payload.endToEndLatencyMs ?? "-"}`;

  latencyMetricsEl.appendChild(li);
}

function applyDashboardMessage(message) {
  hasRenderedRealData = true;

  if (typeof message.connectedClients === "number") {
    clientsEl.textContent = message.connectedClients;
  }

  if (message.metrics) {
    renderMetrics(message.metrics);
  }

  if (Array.isArray(message.topMovies)) {
    renderTopMovies(message.topMovies);
  }

  if (Array.isArray(message.recentActivity)) {
    renderActivity(message.recentActivity);
  }

  if (message.lastProcessedUpdate || message.payload) {
    renderLastUpdate(message.lastProcessedUpdate || message.payload);
  } else if (Array.isArray(message.recentActivity) && message.recentActivity.length > 0) {
    renderLastUpdate(message.recentActivity[0]);
  }
}

async function loadInitialSnapshot() {
  try {
    const response = await fetch(`${snapshotUrl}/snapshot`, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      console.warn(`Snapshot request failed with HTTP ${response.status}`);
      return false;
    }

    const snapshot = await response.json();

    applyDashboardMessage({
      connectedClients: snapshot.connectedClients,
      metrics: snapshot.metrics || null,
      topMovies: snapshot.topMovies || [],
      recentActivity: snapshot.recentActivity || [],
      lastProcessedUpdate:
        snapshot.lastProcessedUpdate ||
        (snapshot.recentActivity && snapshot.recentActivity.length > 0 ? snapshot.recentActivity[0] : null)
    });

    return true;
  } catch (error) {
    console.error("Failed to load initial snapshot", error);
    return false;
  }
}

function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  statusEl.textContent = reconnectAttempt === 0 ? "connecting..." : `reconnecting... attempt ${reconnectAttempt}`;

  const socket = new WebSocket(gatewayUrl);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    statusEl.textContent = "connected";
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "disconnected - reconnecting soon";

    reconnectAttempt += 1;
    const delayMs = Math.min(1000 * reconnectAttempt, 5000);

    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delayMs);
  });

  socket.addEventListener("error", () => {
    statusEl.textContent = "connection error";
  });

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      applyDashboardMessage(message);
    } catch (error) {
      console.error("Invalid WebSocket message", error);
    }
  });
}

async function startDashboard() {
  setLoadingState();

  const snapshotLoaded = await loadInitialSnapshot();

  if (!snapshotLoaded && !hasRenderedRealData) {
    clientsEl.textContent = "-";
    renderMetrics(null);
    renderTopMovies([]);
    renderActivity([]);
    renderLastUpdate(null);
  }

  connectWebSocket();
}

startDashboard();