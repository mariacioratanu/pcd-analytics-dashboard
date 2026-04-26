param(
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
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

function Assert-Contains {
  param(
    [string]$Text,
    [string]$Expected,
    [string]$Message
  )

  Assert-True ($Text -like "*$Expected*") $Message
}

Write-Host "PCD final cloud deployment verification"
Write-Host "Region: $Region"

Write-Step "Reading Google Cloud project"

$ProjectId = gcloud config get-value project
Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectId)) "Google Cloud project is configured"
Write-Host "Project: $ProjectId"

Write-Step "Checking required Cloud Run services"

$RunServicesRaw = gcloud run services list --region $Region --format="value(metadata.name)"
$RunServices = @($RunServicesRaw)

$RequiredRunServices = @(
  "fast-lazy-bee",
  "websocket-gateway",
  "dashboard-client",
  "grpc-analytics-service"
)

foreach ($Service in $RequiredRunServices) {
  Assert-True ($RunServices -contains $Service) "Cloud Run service exists: $Service"
}

$FinalCloudComponentCount = $RequiredRunServices.Count + 1
Write-Host "Final cloud components count: $FinalCloudComponentCount"
Write-Host "Counted components: fast-lazy-bee, websocket-gateway, dashboard-client, grpc-analytics-service, event-processor"

Write-Step "Checking required Cloud Function"

$FunctionsRaw = gcloud functions list --regions=$Region --format="value(name)"
$Functions = @($FunctionsRaw)

Assert-True ($Functions -contains "event-processor") "Cloud Function exists: event-processor"

Write-Step "Reading service URLs"

$FastUrl = gcloud run services describe fast-lazy-bee --region $Region --format="value(status.url)"
$GatewayUrl = gcloud run services describe websocket-gateway --region $Region --format="value(status.url)"
$DashboardUrl = gcloud run services describe dashboard-client --region $Region --format="value(status.url)"
$GrpcAnalyticsUrl = gcloud run services describe grpc-analytics-service --region $Region --format="value(status.url)"

Assert-True (-not [string]::IsNullOrWhiteSpace($FastUrl)) "Fast Lazy Bee URL exists"
Assert-True (-not [string]::IsNullOrWhiteSpace($GatewayUrl)) "WebSocket Gateway URL exists"
Assert-True (-not [string]::IsNullOrWhiteSpace($DashboardUrl)) "Dashboard Client URL exists"
Assert-True (-not [string]::IsNullOrWhiteSpace($GrpcAnalyticsUrl)) "gRPC Analytics Service URL exists"

Write-Host "Fast Lazy Bee: $FastUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"
Write-Host "Dashboard Client: $DashboardUrl"
Write-Host "gRPC Analytics Service: $GrpcAnalyticsUrl"

Write-Step "Checking Pub/Sub topics"

$TopicsRaw = gcloud pubsub topics list --format="value(name)"
$TopicsText = $TopicsRaw -join "`n"

Assert-Contains $TopicsText "topics/resource-events" "Pub/Sub topic exists: resource-events"
Assert-Contains $TopicsText "topics/dashboard-updates" "Pub/Sub topic exists: dashboard-updates"

Write-Step "Checking Pub/Sub subscriptions"

$SubscriptionsRaw = gcloud pubsub subscriptions list --format="value(name)"
$SubscriptionsText = $SubscriptionsRaw -join "`n"

Assert-Contains $SubscriptionsText "subscriptions/dashboard-updates-sub" "Pub/Sub subscription exists: dashboard-updates-sub"
Assert-Contains $SubscriptionsText "subscriptions/eventarc" "Eventarc subscription exists for Cloud Function trigger"

Write-Step "Checking Fast Lazy Bee environment variables"

$FastEnvRaw = gcloud run services describe fast-lazy-bee --region $Region --format="yaml(spec.template.spec.containers[0].env)"
$FastEnvText = $FastEnvRaw -join "`n"

Assert-Contains $FastEnvText "ENABLE_RESOURCE_EVENTS" "Fast Lazy Bee has ENABLE_RESOURCE_EVENTS configured"
Assert-Contains $FastEnvText "true" "Fast Lazy Bee event publishing is enabled"
Assert-Contains $FastEnvText "RESOURCE_EVENTS_TOPIC" "Fast Lazy Bee has RESOURCE_EVENTS_TOPIC configured"
Assert-Contains $FastEnvText "resource-events" "Fast Lazy Bee publishes to resource-events"

Write-Step "Checking WebSocket Gateway environment variables"

$GatewayEnvRaw = gcloud run services describe websocket-gateway --region $Region --format="yaml(spec.template.spec.containers[0].env)"
$GatewayEnvText = $GatewayEnvRaw -join "`n"

Assert-Contains $GatewayEnvText "ANALYTICS_COLLECTION" "Gateway has ANALYTICS_COLLECTION configured"
Assert-Contains $GatewayEnvText "movie-stats" "Gateway reads movie-stats collection"
Assert-Contains $GatewayEnvText "TOP_MOVIES_LIMIT" "Gateway has TOP_MOVIES_LIMIT configured"
Assert-Contains $GatewayEnvText "BACKPRESSURE_ENABLED" "Gateway has BACKPRESSURE_ENABLED configured"
Assert-Contains $GatewayEnvText "BROADCAST_INTERVAL_MS" "Gateway has BROADCAST_INTERVAL_MS configured"
Assert-Contains $GatewayEnvText "ENABLE_DEBUG_ENDPOINTS" "Gateway has ENABLE_DEBUG_ENDPOINTS configured"
Assert-Contains $GatewayEnvText "DEBUG_TOKEN" "Gateway has DEBUG_TOKEN configured"
Assert-Contains $GatewayEnvText "ENABLE_GRPC_ANALYTICS" "Gateway has ENABLE_GRPC_ANALYTICS configured"
Assert-Contains $GatewayEnvText "GRPC_ANALYTICS_TARGET" "Gateway has GRPC_ANALYTICS_TARGET configured"
Assert-Contains $GatewayEnvText "GRPC_DEADLINE_MS" "Gateway has GRPC_DEADLINE_MS configured"

Write-Step "Checking Dashboard Client environment variables"

$DashboardEnvRaw = gcloud run services describe dashboard-client --region $Region --format="yaml(spec.template.spec.containers[0].env)"
$DashboardEnvText = $DashboardEnvRaw -join "`n"

Assert-Contains $DashboardEnvText "WS_URL" "Dashboard Client has WS_URL configured"
Assert-Contains $DashboardEnvText "wss://" "Dashboard Client points to WebSocket Gateway over wss"

Write-Step "Checking gRPC Analytics Service environment variables"

$GrpcEnvRaw = gcloud run services describe grpc-analytics-service --region $Region --format="yaml(spec.template.spec.containers[0].env)"
$GrpcEnvText = $GrpcEnvRaw -join "`n"

Assert-Contains $GrpcEnvText "ANALYTICS_COLLECTION" "gRPC Analytics Service has ANALYTICS_COLLECTION configured"
Assert-Contains $GrpcEnvText "movie-stats" "gRPC Analytics Service reads movie-stats collection"
Assert-Contains $GrpcEnvText "TOP_MOVIES_LIMIT" "gRPC Analytics Service has TOP_MOVIES_LIMIT configured"

Write-Step "Checking Cloud Function environment variables"

$FunctionEnvRaw = gcloud functions describe event-processor --region $Region --gen2 --format="yaml(serviceConfig.environmentVariables)"
$FunctionEnvText = $FunctionEnvRaw -join "`n"

Assert-Contains $FunctionEnvText "ANALYTICS_COLLECTION" "Cloud Function has ANALYTICS_COLLECTION configured"
Assert-Contains $FunctionEnvText "movie-stats" "Cloud Function writes to movie-stats"
Assert-Contains $FunctionEnvText "PROCESSED_COLLECTION" "Cloud Function has PROCESSED_COLLECTION configured"
Assert-Contains $FunctionEnvText "processed-events" "Cloud Function uses processed-events for idempotency"
Assert-Contains $FunctionEnvText "DASHBOARD_UPDATES_TOPIC" "Cloud Function has DASHBOARD_UPDATES_TOPIC configured"
Assert-Contains $FunctionEnvText "dashboard-updates" "Cloud Function publishes dashboard updates"

Write-Step "Checking HTTP health endpoints"

$FastHealth = curl.exe -s -o NUL -w "%{http_code}" "$FastUrl/api/v1/health"
Assert-True ($FastHealth -eq "200") "Fast Lazy Bee health endpoint returned HTTP 200"

$GatewayHealth = curl.exe -s -o NUL -w "%{http_code}" "$GatewayUrl/health"
Assert-True ($GatewayHealth -eq "200") "WebSocket Gateway health endpoint returned HTTP 200"

$DashboardHealth = curl.exe -s -o NUL -w "%{http_code}" "$DashboardUrl/health"
Assert-True ($DashboardHealth -eq "200") "Dashboard Client health endpoint returned HTTP 200"

Write-Step "Checking public runtime endpoints"

$MetricsRaw = curl.exe -s "$GatewayUrl/metrics"
$Metrics = $MetricsRaw | ConvertFrom-Json
Assert-True ($Metrics.service -eq "websocket-gateway") "Gateway /metrics returned service metadata"
Assert-True ($null -ne $Metrics.metrics) "Gateway /metrics returned metrics object"

$SnapshotRaw = curl.exe -s "$GatewayUrl/snapshot"
$Snapshot = $SnapshotRaw | ConvertFrom-Json
Assert-True ($null -ne $Snapshot.metrics) "Gateway /snapshot returned metrics object"
Assert-True ($null -ne $Snapshot.topMovies) "Gateway /snapshot returned topMovies"

$DashboardConfigRaw = curl.exe -s "$DashboardUrl/config.js"
Assert-True ($DashboardConfigRaw.Contains("window.DASHBOARD_CONFIG")) "Dashboard Client exposes runtime config.js"
Assert-True ($DashboardConfigRaw.Contains("wss://")) "Dashboard Client config points to WebSocket URL"

Write-Step "Checking gRPC analytics integration"

$GatewayHealthRaw = curl.exe -s "$GatewayUrl/health"
$GatewayHealth = $GatewayHealthRaw | ConvertFrom-Json

Assert-True ($GatewayHealth.grpcAnalyticsEnabled -eq $true) "Gateway reports gRPC analytics enabled"
Assert-True ($GatewayHealth.grpcAnalyticsConfigured -eq $true) "Gateway reports gRPC analytics configured"

$GrpcTopMoviesRaw = curl.exe -s "$GatewayUrl/grpc/top-movies"
$GrpcTopMovies = $GrpcTopMoviesRaw | ConvertFrom-Json

Assert-True ($GrpcTopMovies.source -eq "grpc") "Gateway /grpc/top-movies uses gRPC"
Assert-True ($GrpcTopMovies.grpcAnalyticsEnabled -eq $true) "Gateway /grpc/top-movies reports gRPC enabled"

$TopMoviesRaw = curl.exe -s "$GatewayUrl/top-movies"
$TopMovies = $TopMoviesRaw | ConvertFrom-Json

Assert-True ($TopMovies.source -eq "grpc") "Gateway /top-movies uses gRPC before fallback"
Assert-True ($null -eq $TopMovies.lastGrpcError) "Gateway /top-movies reports no gRPC error"

$GatewayMetricsRaw = curl.exe -s "$GatewayUrl/metrics"
$GatewayMetrics = $GatewayMetricsRaw | ConvertFrom-Json

Assert-True ($GatewayMetrics.state.topMoviesSource -eq "grpc") "Gateway metrics report topMoviesSource=grpc"
Assert-True ($GatewayMetrics.state.grpcAnalyticsEnabled -eq $true) "Gateway metrics report gRPC enabled"
Assert-True ($GatewayMetrics.state.grpcAnalyticsTargetConfigured -eq $true) "Gateway metrics report gRPC target configured"
Assert-True ($null -eq $GatewayMetrics.state.lastGrpcError) "Gateway metrics report no gRPC error"

Write-Step "Checking debug endpoint protection"

$UnauthorizedDebugStatus = curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" --data "{}" "$GatewayUrl/debug/reset"
Assert-True ($UnauthorizedDebugStatus -eq "403") "Gateway debug reset is protected without token"

Write-Host ""
Write-Host "Final cloud deployment verification completed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Verified components:"
Write-Host "- fast-lazy-bee             $FastUrl"
Write-Host "- event-processor           Cloud Function Gen2 in $Region"
Write-Host "- websocket-gateway         $GatewayUrl"
Write-Host "- dashboard-client          $DashboardUrl"
Write-Host "- grpc-analytics-service    $GrpcAnalyticsUrl"
Write-Host ""
Write-Host "Verified cloud services:"
Write-Host "- Cloud Run"
Write-Host "- Cloud Functions Gen2"
Write-Host "- Pub/Sub"
Write-Host "- Firestore-backed runtime state"
Write-Host "- gRPC internal service communication"
Write-Host ""