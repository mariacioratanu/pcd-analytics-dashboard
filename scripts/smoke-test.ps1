param(
  [string]$Region = "us-central1",
  [string]$MovieId = "573a1390f29313caabcd42e8",
  [int]$WaitSeconds = 8,
  [string]$DebugToken = $env:DEBUG_TOKEN
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    Write-Host "FAIL: $Message" -ForegroundColor Red
    exit 1
  }

  Write-Host "PASS: $Message" -ForegroundColor Green
}

Write-Host "PCD distributed analytics smoke test"
Write-Host "Region: $Region"
Write-Host "MovieId: $MovieId"

Write-Step "Reading Google Cloud project and service URLs"

$ProjectId = gcloud config get-value project
$FastUrl = gcloud run services describe fast-lazy-bee --region $Region --format="value(status.url)"
$GatewayUrl = gcloud run services describe websocket-gateway --region $Region --format="value(status.url)"
$DashboardUrl = gcloud run services describe dashboard-client --region $Region --format="value(status.url)"

Write-Host "Project: $ProjectId"
Write-Host "Fast Lazy Bee: $FastUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"
Write-Host "Dashboard Client: $DashboardUrl"

Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectId)) "Google Cloud project is configured"
Assert-True (-not [string]::IsNullOrWhiteSpace($FastUrl)) "Fast Lazy Bee URL was found"
Assert-True (-not [string]::IsNullOrWhiteSpace($GatewayUrl)) "WebSocket Gateway URL was found"

Write-Step "Checking Service A health endpoint"

$FastHealthStatus = curl.exe -s -o NUL -w "%{http_code}" "$FastUrl/api/v1/health"
Assert-True ($FastHealthStatus -eq "200") "Fast Lazy Bee health returned HTTP 200"

Write-Step "Checking WebSocket Gateway health endpoint"

$GatewayHealthStatus = curl.exe -s -o NUL -w "%{http_code}" "$GatewayUrl/health"
Assert-True ($GatewayHealthStatus -eq "200") "WebSocket Gateway health returned HTTP 200"

Write-Step "Checking Dashboard Client cloud deployment"

$DashboardHealthStatus = curl.exe -s -o NUL -w "%{http_code}" "$DashboardUrl/health"
Assert-True ($DashboardHealthStatus -eq "200") "Dashboard Client health returned HTTP 200"

$DashboardConfigRaw = curl.exe -s "$DashboardUrl/config.js"
Assert-True ($DashboardConfigRaw.Contains("window.DASHBOARD_CONFIG")) "Dashboard Client exposes runtime config.js"
Assert-True ($DashboardConfigRaw.Contains("wss://")) "Dashboard Client config contains WebSocket URL"

$DashboardHtmlStatus = curl.exe -s -o NUL -w "%{http_code}" "$DashboardUrl/"
Assert-True ($DashboardHtmlStatus -eq "200") "Dashboard Client root page returned HTTP 200"

Write-Step "Checking dedicated metrics endpoint"

$MetricsRaw = curl.exe -s "$GatewayUrl/metrics"
$MetricsResponse = $MetricsRaw | ConvertFrom-Json
Assert-True ($MetricsResponse.service -eq "websocket-gateway") "Gateway /metrics endpoint returned service metadata"
Assert-True ($null -ne $MetricsResponse.metrics) "Gateway /metrics endpoint returned metrics object"

Write-Step "Checking debug endpoint protection"

$UnauthorizedResetStatus = curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" --data "{}" "$GatewayUrl/debug/reset"
Assert-True ($UnauthorizedResetStatus -eq "403") "Debug reset without token returned HTTP 403"

if ([string]::IsNullOrWhiteSpace($DebugToken)) {
  Write-Host "DEBUG_TOKEN is not set. Skipping authorized reset and using current gateway state." -ForegroundColor Yellow
} else {
  Write-Step "Resetting gateway runtime metrics with debug token"

  $ResetStatus = curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "x-debug-token: $DebugToken" --data "{}" "$GatewayUrl/debug/reset"
  Assert-True ($ResetStatus -eq "200") "Debug reset with token returned HTTP 200"
}

Write-Step "Triggering one movie view event"

$MovieStatus = curl.exe -s -o NUL -w "%{http_code}" "$FastUrl/api/v1/movies/$MovieId"
Assert-True ($MovieStatus -eq "200") "GET /movies/$MovieId returned HTTP 200"

Write-Host "Waiting $WaitSeconds seconds for Pub/Sub, Cloud Function, Firestore, and Gateway processing..."
Start-Sleep -Seconds $WaitSeconds

Write-Step "Checking gateway snapshot after event"

$SnapshotRaw = curl.exe -s "$GatewayUrl/snapshot"
$Snapshot = $SnapshotRaw | ConvertFrom-Json

Assert-True ($null -ne $Snapshot.metrics) "Snapshot contains metrics"
Assert-True ($Snapshot.metrics.totalUpdates -ge 1) "At least one update was processed"
Assert-True ($Snapshot.metrics.sampleCount -ge 1) "At least one latency sample was recorded"
Assert-True ($null -ne $Snapshot.lastProcessedUpdate) "Snapshot contains lastProcessedUpdate"
Assert-True ($Snapshot.lastProcessedUpdate.movieId -eq $MovieId) "Last processed update matches requested movie"
Assert-True ($Snapshot.lastProcessedUpdate.endToEndLatencyMs -ge 0) "End-to-end latency is present"
Assert-True ($Snapshot.topMovies.Count -ge 1) "Top movies list is not empty"

Write-Step "Checking top movies endpoint"

$TopMoviesRaw = curl.exe -s "$GatewayUrl/top-movies"
$TopMoviesResponse = $TopMoviesRaw | ConvertFrom-Json

Assert-True ($TopMoviesResponse.count -ge 1) "Top movies endpoint returned at least one movie"
Assert-True ($TopMoviesResponse.topMovies[0].viewCount -ge 1) "Top movie has a positive view count"

Write-Host ""
Write-Host "Smoke test completed successfully" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:"
Write-Host "Project: $ProjectId"
Write-Host "Fast Lazy Bee: $FastUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"
Write-Host "Dashboard Client: $DashboardUrl"
Write-Host "Processed updates: $($Snapshot.metrics.totalUpdates)"
Write-Host "Latency samples: $($Snapshot.metrics.sampleCount)"
Write-Host "Latest end-to-end latency: $($Snapshot.metrics.latestLatencyMs) ms"
Write-Host "Top movie: $($TopMoviesResponse.topMovies[0].movieTitle) / views=$($TopMoviesResponse.topMovies[0].viewCount)"