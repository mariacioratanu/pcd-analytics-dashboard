const MAX_RECENT_ITEMS = 20;
const MAX_CHART_POINTS = 20;

const state = {
  metrics: {
    totalUpdates: 0,
    totalBroadcasts: 0,
    coalescedUpdates: 0,
    connectedClients: 0,
    totalClientConnections: 0,
    totalClientDisconnects: 0,
    sampleCount: 0,
    latestLatencyMs: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    p99LatencyMs: null,
    backpressureEnabled: false,
    broadcastIntervalMs: null
  },
  topMovies: [],
  recentActivity: [],
  lastProcessedUpdate: null,
  latencySeries: []
};

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

const els = {
  connectionStatus: document.getElementById('connectionStatus'),
  connectionStatusText: document.getElementById('connectionStatusText'),
  wsEndpoint: document.getElementById('wsEndpoint'),
  httpEndpoint: document.getElementById('httpEndpoint'),
  lastUiUpdate: document.getElementById('lastUiUpdate'),
  reconnectAttempts: document.getElementById('reconnectAttempts'),

  connectedClients: document.getElementById('connectedClients'),
  totalUpdates: document.getElementById('totalUpdates'),
  totalBroadcasts: document.getElementById('totalBroadcasts'),
  coalescedUpdates: document.getElementById('coalescedUpdates'),
  latestLatency: document.getElementById('latestLatency'),
  gatewayLatency: document.getElementById('gatewayLatency'),

  p50Latency: document.getElementById('p50Latency'),
  p95Latency: document.getElementById('p95Latency'),
  p99Latency: document.getElementById('p99Latency'),
  sampleCount: document.getElementById('sampleCount'),
  backpressureEnabled: document.getElementById('backpressureEnabled'),
  broadcastInterval: document.getElementById('broadcastInterval'),
  totalClientConnections: document.getElementById('totalClientConnections'),
  totalClientDisconnects: document.getElementById('totalClientDisconnects'),

  latencySummaryBadge: document.getElementById('latencySummaryBadge'),
  topMoviesCountBadge: document.getElementById('topMoviesCountBadge'),
  recentActivityCountBadge: document.getElementById('recentActivityCountBadge'),

  topMoviesContainer: document.getElementById('topMoviesContainer'),
  lastProcessedContainer: document.getElementById('lastProcessedContainer'),
  recentActivityContainer: document.getElementById('recentActivityContainer'),

  latencyChart: document.getElementById('latencyChart')
};

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function normalizeWebSocketUrl(value) {
  if (!value) {
    return '';
  }

  const trimmed = String(value).trim();

  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }

  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }

  return trimmed;
}

function getWebSocketUrl() {
  const fromQuery = getQueryParam('ws');
  if (fromQuery) {
    return normalizeWebSocketUrl(fromQuery);
  }

  const fromConfig = window.DASHBOARD_CONFIG?.wsUrl;
  if (fromConfig) {
    return normalizeWebSocketUrl(fromConfig);
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function httpBaseFromWs(wsUrl) {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US').format(value);
}

function formatMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${Math.round(value)} ms`;
}

function formatDate(value) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setConnectionStatus(status, label) {
  els.connectionStatus.classList.remove('connected', 'disconnected');
  if (status === 'connected') {
    els.connectionStatus.classList.add('connected');
  } else if (status === 'disconnected') {
    els.connectionStatus.classList.add('disconnected');
  }
  els.connectionStatusText.textContent = label;
}

function updateLastUiUpdate() {
  els.lastUiUpdate.textContent = new Date().toLocaleTimeString();
}

function mergeMetrics(incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return;
  }
  state.metrics = {
    ...state.metrics,
    ...incoming
  };
}

function mergeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return;
  }

  if (snapshot.metrics) {
    mergeMetrics(snapshot.metrics);
  }

  if (Array.isArray(snapshot.topMovies)) {
    state.topMovies = snapshot.topMovies;
  }

  if (Array.isArray(snapshot.recentActivity)) {
    state.recentActivity = snapshot.recentActivity.slice(0, MAX_RECENT_ITEMS);
    rebuildLatencySeriesFromRecentActivity();
  }

  if (snapshot.lastProcessedUpdate) {
    state.lastProcessedUpdate = snapshot.lastProcessedUpdate;
    maybePushLatencyPoint(snapshot.lastProcessedUpdate.endToEndLatencyMs);
  }
}

function rebuildLatencySeriesFromRecentActivity() {
  const series = state.recentActivity
    .map(item => item?.endToEndLatencyMs)
    .filter(value => typeof value === 'number' && !Number.isNaN(value))
    .slice(0, MAX_CHART_POINTS)
    .reverse();

  state.latencySeries = series;
}

function maybePushLatencyPoint(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return;
  }

  state.latencySeries.push(value);
  if (state.latencySeries.length > MAX_CHART_POINTS) {
    state.latencySeries.shift();
  }
}

async function fetchSnapshot(httpBase) {
  if (!httpBase) return;

  try {
    const response = await fetch(`${httpBase}/snapshot`, {
      headers: {
        'Cache-Control': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`Snapshot request failed: ${response.status}`);
    }

    const data = await response.json();
    mergeSnapshot(data);
    renderAll();
  } catch (error) {
    console.warn('Failed to fetch snapshot:', error);
  }
}

function handleIncomingMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (payload.snapshot && typeof payload.snapshot === 'object') {
    mergeSnapshot(payload.snapshot);
    renderAll();
    return;
  }

  if (payload.metrics || payload.topMovies || payload.recentActivity || payload.lastProcessedUpdate) {
    mergeSnapshot(payload);
    renderAll();
    return;
  }

  if (payload.type === 'movie_viewed_processed') {
    state.lastProcessedUpdate = payload;
    state.recentActivity = [payload, ...state.recentActivity].slice(0, MAX_RECENT_ITEMS);
    maybePushLatencyPoint(payload.endToEndLatencyMs);
    renderAll();
    return;
  }
}

function renderSummaryCards() {
  const m = state.metrics;

  els.connectedClients.textContent = formatNumber(m.connectedClients);
  els.totalUpdates.textContent = formatNumber(m.totalUpdates);
  els.totalBroadcasts.textContent = formatNumber(m.totalBroadcasts);
  els.coalescedUpdates.textContent = formatNumber(m.coalescedUpdates);
  els.latestLatency.textContent = formatMs(m.latestLatencyMs);

  const last = state.lastProcessedUpdate;
  const consistencyWindow = last?.gatewayLatencyMs ?? m.latestLatencyMs ?? null;
  els.gatewayLatency.textContent = formatMs(consistencyWindow);
}

function renderMetricsPanel() {
  const m = state.metrics;

  els.p50Latency.textContent = formatMs(m.p50LatencyMs);
  els.p95Latency.textContent = formatMs(m.p95LatencyMs);
  els.p99Latency.textContent = formatMs(m.p99LatencyMs);
  els.sampleCount.textContent = formatNumber(m.sampleCount);
  els.backpressureEnabled.textContent = m.backpressureEnabled ? 'Yes' : 'No';
  els.broadcastInterval.textContent = m.broadcastIntervalMs ? `${m.broadcastIntervalMs} ms` : '—';
  els.totalClientConnections.textContent = formatNumber(m.totalClientConnections);
  els.totalClientDisconnects.textContent = formatNumber(m.totalClientDisconnects);

  const summary = [];
  if (m.p50LatencyMs != null) summary.push(`p50 ${Math.round(m.p50LatencyMs)} ms`);
  if (m.p95LatencyMs != null) summary.push(`p95 ${Math.round(m.p95LatencyMs)} ms`);
  if (m.p99LatencyMs != null) summary.push(`p99 ${Math.round(m.p99LatencyMs)} ms`);

  els.latencySummaryBadge.textContent = summary.length > 0 ? summary.join(' • ') : 'No samples yet';
}

function renderTopMovies() {
  const items = Array.isArray(state.topMovies) ? state.topMovies : [];
  els.topMoviesCountBadge.textContent = `${items.length} movie${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    els.topMoviesContainer.innerHTML = `
      <div class="empty-state">
        No ranked movies available yet. Trigger some movie access events to populate this table.
      </div>
    `;
    return;
  }

  const rows = items.map((movie, index) => `
    <tr>
      <td><span class="rank-pill">#${index + 1}</span></td>
      <td>
        <div class="movie-title">${escapeHtml(movie.movieTitle || 'Unknown movie')}</div>
        <div class="muted">${escapeHtml(movie.movieId || '—')}</div>
      </td>
      <td>${formatNumber(movie.viewCount)}</td>
      <td>${formatDate(movie.lastViewed)}</td>
      <td>${formatDate(movie.updatedAt)}</td>
    </tr>
  `).join('');

  els.topMoviesContainer.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Movie</th>
          <th>Views</th>
          <th>Last Viewed</th>
          <th>Updated At</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderLastProcessed() {
  const item = state.lastProcessedUpdate;

  if (!item) {
    els.lastProcessedContainer.innerHTML = `
      <div class="empty-state">
        No processed update has been received yet.
      </div>
    `;
    return;
  }

  els.lastProcessedContainer.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item">
        <span>Event type</span>
        <strong>${escapeHtml(item.type || '—')}</strong>
      </div>
      <div class="detail-item">
        <span>Movie title</span>
        <strong>${escapeHtml(item.movieTitle || 'Unknown movie')}</strong>
      </div>
      <div class="detail-item">
        <span>Movie ID</span>
        <strong>${escapeHtml(item.movieId || '—')}</strong>
      </div>
      <div class="detail-item">
        <span>View count</span>
        <strong>${formatNumber(item.viewCount)}</strong>
      </div>
      <div class="detail-item">
        <span>Accessed at</span>
        <strong>${formatDate(item.accessedAt)}</strong>
      </div>
      <div class="detail-item">
        <span>Processed at</span>
        <strong>${formatDate(item.processedAt)}</strong>
      </div>
      <div class="detail-item">
        <span>Gateway received at</span>
        <strong>${formatDate(item.gatewayReceivedAt)}</strong>
      </div>
      <div class="detail-item">
        <span>Last viewed</span>
        <strong>${formatDate(item.lastViewed)}</strong>
      </div>
      <div class="detail-item">
        <span>Processing latency</span>
        <strong>${formatMs(item.processingLatencyMs)}</strong>
      </div>
      <div class="detail-item">
        <span>Gateway latency</span>
        <strong>${formatMs(item.gatewayLatencyMs)}</strong>
      </div>
      <div class="detail-item">
        <span>End-to-end latency</span>
        <strong>${formatMs(item.endToEndLatencyMs)}</strong>
      </div>
      <div class="detail-item">
        <span>Event ID / correlation hint</span>
        <strong>${escapeHtml(item.eventId || item.messageId || 'Not exposed in payload')}</strong>
      </div>
    </div>
  `;
}

function renderRecentActivity() {
  const items = Array.isArray(state.recentActivity) ? state.recentActivity : [];
  els.recentActivityCountBadge.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    els.recentActivityContainer.innerHTML = `
      <div class="empty-state">
        No recent activity yet. Access a movie resource to see live event propagation.
      </div>
    `;
    return;
  }

  els.recentActivityContainer.innerHTML = items.map(item => `
    <div class="recent-item">
      <div class="recent-top">
        <div class="recent-title">${escapeHtml(item.movieTitle || 'Unknown movie')}</div>
        <div class="recent-view-count">Views: ${formatNumber(item.viewCount)}</div>
      </div>

      <div class="recent-grid">
        <div>
          Type
          <strong>${escapeHtml(item.type || '—')}</strong>
        </div>
        <div>
          Movie ID
          <strong>${escapeHtml(item.movieId || '—')}</strong>
        </div>
        <div>
          Accessed at
          <strong>${formatDate(item.accessedAt)}</strong>
        </div>
        <div>
          Last viewed
          <strong>${formatDate(item.lastViewed)}</strong>
        </div>
        <div>
          Processing latency
          <strong>${formatMs(item.processingLatencyMs)}</strong>
        </div>
        <div>
          Gateway latency
          <strong>${formatMs(item.gatewayLatencyMs)}</strong>
        </div>
        <div>
          End-to-end latency
          <strong>${formatMs(item.endToEndLatencyMs)}</strong>
        </div>
        <div>
          Processed at
          <strong>${formatDate(item.processedAt)}</strong>
        </div>
      </div>
    </div>
  `).join('');
}

function renderLatencyChart() {
  const canvas = els.latencyChart;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  ctx.clearRect(0, 0, width, height);

  const points = state.latencySeries.slice(-MAX_CHART_POINTS);

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, 'rgba(181, 167, 255, 0.12)');
  bgGradient.addColorStop(1, 'rgba(142, 228, 182, 0.03)');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  const padding = { top: 24, right: 24, bottom: 34, left: 48 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  if (points.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No latency samples yet', width / 2, height / 2);
    return;
  }

  const maxValue = Math.max(...points, 100);
  const minValue = 0;

  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '12px Inter, sans-serif';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i++) {
    const value = Math.round(maxValue - ((maxValue - minValue) / 4) * i);
    const y = padding.top + (chartH / 4) * i;
    ctx.fillText(`${value} ms`, padding.left - 8, y + 4);
  }

  const getX = (index) =>
    padding.left + (index / Math.max(points.length - 1, 1)) * chartW;

  const getY = (value) =>
    padding.top + chartH - ((value - minValue) / Math.max(maxValue - minValue, 1)) * chartH;

  const areaGradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
  areaGradient.addColorStop(0, 'rgba(94, 212, 156, 0.28)');
  areaGradient.addColorStop(1, 'rgba(145, 124, 255, 0.02)');

  ctx.beginPath();
  ctx.moveTo(getX(0), getY(points[0]));
  points.forEach((value, index) => {
    ctx.lineTo(getX(index), getY(value));
  });
  ctx.lineTo(getX(points.length - 1), padding.top + chartH);
  ctx.lineTo(getX(0), padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = areaGradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((value, index) => {
    const x = getX(index);
    const y = getY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  const strokeGradient = ctx.createLinearGradient(padding.left, 0, width - padding.right, 0);
  strokeGradient.addColorStop(0, '#b5a7ff');
  strokeGradient.addColorStop(1, '#8ee4b6');
  ctx.strokeStyle = strokeGradient;
  ctx.lineWidth = 3;
  ctx.stroke();

  points.forEach((value, index) => {
    const x = getX(index);
    const y = getY(value);

    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#8ee4b6';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  });
}

function renderAll() {
  renderSummaryCards();
  renderMetricsPanel();
  renderTopMovies();
  renderLastProcessed();
  renderRecentActivity();
  renderLatencyChart();
  updateLastUiUpdate();
}

function scheduleReconnect(wsUrl, httpBase) {
  clearTimeout(reconnectTimer);
  reconnectAttempts += 1;
  els.reconnectAttempts.textContent = String(reconnectAttempts);
  setConnectionStatus('disconnected', `Disconnected • reconnecting in 3s`);

  reconnectTimer = setTimeout(() => {
    connectWebSocket(wsUrl, httpBase);
  }, 3000);
}

function connectWebSocket(wsUrl, httpBase) {
  try {
    ws = new WebSocket(wsUrl);
  } catch (error) {
    console.error('WebSocket init failed:', error);
    scheduleReconnect(wsUrl, httpBase);
    return;
  }

  ws.addEventListener('open', async () => {
    reconnectAttempts = 0;
    els.reconnectAttempts.textContent = '0';
    setConnectionStatus('connected', 'Connected');
    await fetchSnapshot(httpBase);
  });

  ws.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleIncomingMessage(payload);
    } catch (error) {
      console.warn('Failed to parse WebSocket message:', error, event.data);
    }
  });

  ws.addEventListener('close', () => {
    setConnectionStatus('disconnected', 'Connection lost');
    scheduleReconnect(wsUrl, httpBase);
  });

  ws.addEventListener('error', () => {
    if (ws) {
      ws.close();
    }
  });
}

function init() {
  const wsUrl = getWebSocketUrl();
  const httpBase = httpBaseFromWs(wsUrl);

  els.wsEndpoint.textContent = wsUrl || '—';
  els.httpEndpoint.textContent = httpBase || '—';

  renderAll();
  connectWebSocket(wsUrl, httpBase);
}

init();