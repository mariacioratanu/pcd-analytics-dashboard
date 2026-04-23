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
    recentActivity
  }));

  broadcast({ type: "clients_count", connectedClients });

  ws.on("close", () => {
    clients.delete(ws);
    connectedClients = clients.size;
    broadcast({ type: "clients_count", connectedClients });
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "websocket-gateway", connectedClients });
});

app.post("/pubsub/push", (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.data) {
      return res.status(400).json({ error: "No Pub/Sub message received" });
    }

    const payload = JSON.parse(Buffer.from(message.data, "base64").toString());

    recentActivity.unshift(payload);
    recentActivity = recentActivity.slice(0, 20);

    broadcast({
      type: "dashboard_update",
      connectedClients,
      payload,
      recentActivity
    });

    res.status(200).json({ status: "broadcasted" });
  } catch (error) {
    console.error(JSON.stringify({ msg: "Error handling dashboard update", error: error.message }));
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`WebSocket gateway running on port ${PORT}`);
});
