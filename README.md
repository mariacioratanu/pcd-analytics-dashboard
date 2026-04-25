# PCD Analytics Dashboard

Distributed cloud application developed for the **Programare Concurentă și Distribuită** course.

This project extends the original **Fast Lazy Bee** REST API into an event-driven cloud system with asynchronous processing, serverless functions, Firestore persistence, WebSocket real-time communication, live analytics dashboard, runtime metrics, backpressure, and benchmark scripts.

---

## 1. Architecture

The implemented architecture is:

```text
Client
  |
  v
Fast Lazy Bee REST API / Service A
  |
  | publishes movie_viewed events
  v
Google Pub/Sub topic: resource-events
  |
  v
Cloud Function: event-processor
  |
  | writes aggregated statistics
  v
Firestore collection: movie-stats
  |
  | publishes dashboard update events
  v
Google Pub/Sub topic: dashboard-updates
  |
  v
WebSocket Gateway on Cloud Run
  |
  v
Dashboard Client
```

The system is **event-driven** and **eventually consistent**. The REST API returns the movie response immediately, while the analytics update is processed asynchronously and becomes visible in the dashboard shortly afterward.

---

## 2. Main components

### 2.1 Fast Lazy Bee REST API

Location:

```text
src/
```

Main modified files:

```text
src/routes/movies/movie_id/movie-id-routes.ts
src/utils/pubsub-utils.ts
```

Responsibilities:

- exposes REST endpoints for movies;
- serves movie resources from MongoDB Atlas;
- publishes a `movie_viewed` event when a movie is accessed;
- sends events to the Pub/Sub topic `resource-events`;
- keeps the original Fast Lazy Bee REST API functionality.

During benchmarks, requests use:

```powershell
-H "Cache-Control: no-cache"
```

This forces the request to reach the route handler and generate a new event.

---

### 2.2 Cloud Function: event-processor

Location:

```text
functions/event-processor/
```

Responsibilities:

- triggered by the Pub/Sub topic `resource-events`;
- decodes the incoming movie view event;
- updates aggregated movie statistics in Firestore;
- stores processed event identifiers in `processed-events` for idempotency;
- publishes dashboard update events to the Pub/Sub topic `dashboard-updates`.

Firestore collections:

```text
movie-stats
processed-events
```

Idempotency is important because Pub/Sub provides **at-least-once delivery**, meaning that the same message may theoretically be delivered more than once.

---

### 2.3 WebSocket Gateway

Location:

```text
websocket-gateway/
```

Responsibilities:

- runs on Google Cloud Run;
- receives dashboard updates through a Pub/Sub push subscription;
- maintains connected WebSocket clients;
- exposes runtime endpoints:
  - `/health`
  - `/snapshot`
  - `/top-movies`
  - `/debug/reset`
- broadcasts live updates to dashboard clients;
- computes runtime metrics:
  - total updates;
  - total WebSocket broadcasts;
  - coalesced updates;
  - latest latency;
  - p50 latency;
  - p95 latency;
  - p99 latency;
- implements backpressure through update coalescing.

For demo stability, the WebSocket Gateway is deployed with:

```text
--min-instances 1
--max-instances 1
```

This keeps the WebSocket state in one Cloud Run instance. A production-grade multi-instance version would require shared state or fanout infrastructure, such as Redis, Pub/Sub fanout, or sticky sessions.

---

### 2.4 Dashboard Client

Location:

```text
dashboard-client/
```

Responsibilities:

- connects to the WebSocket Gateway;
- loads an initial `/snapshot` before opening the WebSocket connection;
- displays connected clients;
- displays top viewed movies;
- displays recent activity;
- displays the last processed update;
- displays live latency metrics;
- displays a realtime latency chart;
- automatically reconnects after WebSocket disconnection.

The dashboard is intentionally implemented with plain HTML, CSS, and JavaScript to keep the demo lightweight and easy to run.

---

### 2.5 Benchmark scripts

Location:

```text
scripts/
```

Scripts:

```text
scripts/benchmark-burst.ps1
scripts/benchmark-consistency.ps1
```

Responsibilities:

- generate controlled traffic;
- reset runtime metrics before benchmark runs;
- collect JSON and CSV benchmark results;
- evaluate throughput, latency, consistency window, and backpressure behavior.

Benchmark results are generated locally in:

```text
benchmark-results/
```

This folder is ignored by Git.

---

## 3. Cloud services used

The project uses the following cloud-native services:

```text
Google Cloud Run
Google Cloud Functions 2nd gen
Google Pub/Sub
Google Firestore
Google Artifact Registry
Google Cloud Build
MongoDB Atlas
```

---

## 4. Pub/Sub topics

The project uses these Pub/Sub topics:

```text
resource-events
dashboard-updates
```

The topic `resource-events` receives events from Fast Lazy Bee.

The topic `dashboard-updates` receives processed analytics updates from the Cloud Function and forwards them to the WebSocket Gateway through a push subscription.

An optional topic from previous lab experiments may still exist:

```text
movie-events
```

This is not part of the final project flow.

---

## 5. Required environment variables

### 5.1 Fast Lazy Bee

```text
MONGO_URL
MONGO_DB_NAME
ENABLE_RESOURCE_EVENTS=true
RESOURCE_EVENTS_TOPIC=resource-events
```

### 5.2 Cloud Function: event-processor

```text
ANALYTICS_COLLECTION=movie-stats
PROCESSED_COLLECTION=processed-events
DASHBOARD_UPDATES_TOPIC=dashboard-updates
```

### 5.3 WebSocket Gateway

```text
ANALYTICS_COLLECTION=movie-stats
TOP_MOVIES_LIMIT=10
BACKPRESSURE_ENABLED=true
BROADCAST_INTERVAL_MS=1000
ENABLE_DEBUG_ENDPOINTS=true
```

`ENABLE_DEBUG_ENDPOINTS=true` is used for reproducible benchmark runs. It enables `/debug/reset`, which clears runtime metrics from the WebSocket Gateway memory without deleting Firestore data.

---

## 6. Local build

From the repository root:

```powershell
npm run build
```

The original Fast Lazy Bee tests use `mongodb-memory-server` and MongoDB archive import. On Windows, these tests may be slow or unstable because they download and import MongoDB test data.

For the final distributed system, the main verification flow is:

```powershell
npm run build
```

plus functional cloud tests and benchmark scripts.

---

## 7. Deploy WebSocket Gateway

Set variables:

```powershell
$REGION="us-central1"
```

```powershell
$PROJECT_ID=(gcloud config get-value project)
```

```powershell
$REPO="$REGION-docker.pkg.dev/$PROJECT_ID/myrepo"
```

Build image:

```powershell
cd C:\Users\maria\pcd\project\websocket-gateway
```

```powershell
gcloud builds submit --tag $REPO/websocket-gateway:v6
```

Deploy:

```powershell
gcloud run deploy websocket-gateway --image $REPO/websocket-gateway:v6 --platform managed --region $REGION --allow-unauthenticated --port 8080 --min-instances 1 --max-instances 1 '--set-env-vars=ANALYTICS_COLLECTION=movie-stats,TOP_MOVIES_LIMIT=10,BACKPRESSURE_ENABLED=true,BROADCAST_INTERVAL_MS=1000,ENABLE_DEBUG_ENDPOINTS=true'
```

Verify environment variables:

```powershell
gcloud run services describe websocket-gateway --region us-central1 --format="yaml(spec.template.spec.containers[0].env)"
```

Expected values:

```text
ANALYTICS_COLLECTION=movie-stats
TOP_MOVIES_LIMIT=10
BACKPRESSURE_ENABLED=true
BROADCAST_INTERVAL_MS=1000
ENABLE_DEBUG_ENDPOINTS=true
```

---

## 8. Run dashboard locally

Start the static dashboard server:

```powershell
cd C:\Users\maria\pcd\project\dashboard-client
```

```powershell
npx serve . -l 5500
```

Get the WebSocket Gateway URL:

```powershell
$REGION="us-central1"
```

```powershell
$WS_GATEWAY_URL=(gcloud run services describe websocket-gateway --region $REGION --format="value(status.url)")
```

```powershell
$WS_URL=$WS_GATEWAY_URL -replace "^https://","wss://"
```

Open dashboard:

```powershell
Start-Process "http://localhost:5500/?ws=$WS_URL"
```

---

## 9. Functional cloud test

Get service URLs:

```powershell
$REGION="us-central1"
```

```powershell
$FAST_URL=(gcloud run services describe fast-lazy-bee --region $REGION --format="value(status.url)")
```

```powershell
$WS_GATEWAY_URL=(gcloud run services describe websocket-gateway --region $REGION --format="value(status.url)")
```

Set movie id:

```powershell
$MOVIE_ID="573a1390f29313caabcd42e8"
```

Trigger one movie view event:

```powershell
curl.exe -s -H "Cache-Control: no-cache" "$FAST_URL/api/v1/movies/$MOVIE_ID"
```

Wait a few seconds:

```powershell
Start-Sleep -Seconds 5
```

Check WebSocket Gateway snapshot:

```powershell
curl.exe -s "$WS_GATEWAY_URL/snapshot" | jq
```

Expected result:

- `recentActivity` contains the processed movie view;
- `lastProcessedUpdate` is populated;
- `topMovies` contains the viewed movie;
- `metrics.totalUpdates` increases;
- the dashboard updates live.

---

## 10. Runtime endpoints

### Health

```powershell
curl.exe -s "$WS_GATEWAY_URL/health"
```

### Snapshot

```powershell
curl.exe -s "$WS_GATEWAY_URL/snapshot" | jq
```

### Top viewed movies

```powershell
curl.exe -s "$WS_GATEWAY_URL/top-movies" | jq
```

### Reset runtime metrics

```powershell
curl.exe -s -X POST -H "Content-Type: application/json" --data "{}" "$WS_GATEWAY_URL/debug/reset" | jq
```

The reset endpoint clears in-memory runtime metrics, recent activity, latency samples, and broadcast counters. It does not delete Firestore data.

---

## 11. Benchmark: burst and backpressure

Run 20 requests:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\benchmark-burst.ps1 -Requests 20 -WaitSeconds 15
```

Run 50 requests:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\benchmark-burst.ps1 -Requests 50 -WaitSeconds 20
```

Observed results:

| Requests | Total updates | WebSocket broadcasts | Coalesced updates | Approx. request rate | p50 latency | p95 latency | p99 latency |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 20 | 6 | 14 | 3.58 req/s | 1271 ms | 11090 ms | 11186 ms |
| 50 | 50 | 10 | 40 | 3.73 req/s | 196 ms | 1959 ms | 2353 ms |

The results show that backpressure is active. For example, in the 50-request test, the gateway received 50 updates but sent only 10 WebSocket broadcasts, coalescing 40 updates.

This reduces the number of messages sent to connected dashboard clients during burst traffic while still keeping the dashboard state up to date.

---

## 12. Benchmark: consistency window

Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\benchmark-consistency.ps1 -Trials 5 -PollIntervalMs 500 -TimeoutSeconds 30
```

Observed results:

| Metric | Value |
|---|---:|
| Successful trials | 5 / 5 |
| Average consistency window | 1396.75 ms |
| Minimum consistency window | 1063.37 ms |
| Maximum consistency window | 2617.48 ms |
| Average end-to-end latency | 652.2 ms |
| Average Cloud Function processing latency | 74.2 ms |
| Average gateway latency | 578 ms |

The system is eventually consistent. The API request returns before the dashboard is updated, but the update becomes visible shortly afterward. The measured average external consistency window was approximately 1.4 seconds.

The consistency window measurement includes polling from the benchmark script, while `endToEndLatencyMs` is computed from timestamps inside the distributed flow.

---

## 13. Bonus features implemented

The project includes the following extensions beyond the minimal flow:

```text
Realtime latency chart
Top viewed movies section
WebSocket reconnection
Initial snapshot loading before WebSocket connection
Backpressure / coalescing in WebSocket Gateway
Benchmark scripts with JSON and CSV output
Debug reset endpoint for reproducible measurements
p50 / p95 / p99 latency metrics
Runtime WebSocket broadcast metrics
Firestore-backed top movies reconstruction after gateway restart
```

---

## 14. Demo checklist

Before the live demo:

1. Open the repository in VS Code.
2. Open Google Cloud Console.
3. Start the dashboard locally.
4. Open the dashboard in the browser.
5. Trigger movie view requests from PowerShell.
6. Show live dashboard updates.
7. Show `/snapshot`.
8. Show `/top-movies`.
9. Show Firestore `movie-stats`.
10. Show Pub/Sub topics and subscriptions.
11. Show Cloud Function `event-processor`.
12. Show Cloud Run services.
13. Run or show benchmark scripts.
14. Explain backpressure results.
15. Explain consistency window results.

---

## 15. Repository structure

```text
dashboard-client/
  index.html
  app.js

functions/
  event-processor/
    index.js
    package.json

scripts/
  benchmark-burst.ps1
  benchmark-consistency.ps1

src/
  Fast Lazy Bee REST API source code

websocket-gateway/
  index.js
  package.json
  Dockerfile

README.md
Dockerfile
package.json
```

---

## 16. Current project status

Implemented and validated:

```text
Fast Lazy Bee deployed on Cloud Run
Cloud Function event-processor active
Pub/Sub event flow working
Firestore movie-stats updates working
WebSocket Gateway deployed on Cloud Run
Dashboard live updates working
Top viewed movies working
Latency metrics working
Realtime latency chart working
Backpressure working
Benchmark scripts working
Consistency window benchmark working
```

The project is ready for final reporting and demo preparation.