const statusEl = document.getElementById("status");
const clientsEl = document.getElementById("clients");
const activityEl = document.getElementById("activity");
const latencyMetricsEl = document.getElementById("latency-metrics");
const gatewayUrlEl = document.getElementById("gateway-url");

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
    li.textContent = `${title} | views=${count} | time=${when}`;
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
  li.textContent = `${payload.movieTitle || payload.movieId} | views=${payload.viewCount ?? "?"} | processedAt=${payload.processedAt || payload.lastViewed || "-"}`;
  latencyMetricsEl.appendChild(li);
}

statusEl.textContent = "connecting";
renderActivity([]);
renderLastUpdate(null);

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

  if (Array.isArray(message.recentActivity)) {
    renderActivity(message.recentActivity);

    if (message.recentActivity.length > 0) {
      renderLastUpdate(message.payload || message.recentActivity[0]);
    } else {
      renderLastUpdate(message.payload || null);
    }
  } else if (message.payload) {
    renderLastUpdate(message.payload);
  }
});
