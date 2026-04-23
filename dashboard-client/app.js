const statusEl = document.getElementById("status");
const clientsEl = document.getElementById("clients");
const activityEl = document.getElementById("activity");
const latencyMetricsEl = document.getElementById("latency-metrics");

const gatewayUrl = localStorage.getItem("gatewayUrl") || "ws://localhost:8080";
const socket = new WebSocket(gatewayUrl);

function renderActivity(items) {
  activityEl.innerHTML = "";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${item.movieTitle || item.movieId} -> views: ${item.viewCount || "?"}`;
    activityEl.appendChild(li);
  });
}

socket.addEventListener("open", () => {
  statusEl.textContent = "connected";
});

socket.addEventListener("close", () => {
  statusEl.textContent = "disconnected";
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  if (typeof message.connectedClients === "number") {
    clientsEl.textContent = message.connectedClients;
  }

  if (Array.isArray(message.recentActivity)) {
    renderActivity(message.recentActivity);
  }

  if (message.type === "dashboard_update" && message.payload) {
    const li = document.createElement("li");
    li.textContent = `Last event: ${message.payload.movieTitle || message.payload.movieId} -> ${message.payload.viewCount || "?"}`;
    latencyMetricsEl.innerHTML = "";
    latencyMetricsEl.appendChild(li);
  }
});
