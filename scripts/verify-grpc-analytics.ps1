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

Write-Host "PCD gRPC analytics verification"
Write-Host "Region: $Region"

Write-Step "Reading Google Cloud project"

$ProjectId = gcloud config get-value project
Assert-True (-not [string]::IsNullOrWhiteSpace($ProjectId)) "Google Cloud project is configured"
Write-Host "Project: $ProjectId"

Write-Step "Checking Cloud Run services"

$RunServicesRaw = gcloud run services list --region $Region --format="value(metadata.name)"
$RunServices = @($RunServicesRaw)

Assert-True ($RunServices -contains "grpc-analytics-service") "Cloud Run service exists: grpc-analytics-service"
Assert-True ($RunServices -contains "websocket-gateway") "Cloud Run service exists: websocket-gateway"

Write-Step "Reading service URLs"

$GrpcUrl = gcloud run services describe grpc-analytics-service --region $Region --format="value(status.url)"
$GatewayUrl = gcloud run services describe websocket-gateway --region $Region --format="value(status.url)"

Assert-True (-not [string]::IsNullOrWhiteSpace($GrpcUrl)) "gRPC Analytics Service URL exists"
Assert-True (-not [string]::IsNullOrWhiteSpace($GatewayUrl)) "WebSocket Gateway URL exists"

Write-Host "gRPC Analytics Service: $GrpcUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"

Write-Step "Checking WebSocket Gateway gRPC configuration"

$GatewayHealthRaw = curl.exe -s "$GatewayUrl/health"
$GatewayHealth = $GatewayHealthRaw | ConvertFrom-Json

Assert-True ($GatewayHealth.status -eq "ok") "WebSocket Gateway health status is ok"
Assert-True ($GatewayHealth.grpcAnalyticsEnabled -eq $true) "WebSocket Gateway has gRPC analytics enabled"
Assert-True ($GatewayHealth.grpcAnalyticsConfigured -eq $true) "WebSocket Gateway has gRPC analytics configured"

Write-Step "Checking direct gRPC endpoint exposed through gateway"

$GrpcTopMoviesRaw = curl.exe -s "$GatewayUrl/grpc/top-movies"
$GrpcTopMovies = $GrpcTopMoviesRaw | ConvertFrom-Json

Assert-True ($GrpcTopMovies.source -eq "grpc") "Gateway /grpc/top-movies uses gRPC source"
Assert-True ($GrpcTopMovies.grpcAnalyticsEnabled -eq $true) "Gateway reports gRPC analytics enabled"
Assert-True ($GrpcTopMovies.count -ge 0) "Gateway gRPC top movies response contains count"

Write-Step "Checking normal top movies endpoint uses gRPC before fallback"

$TopMoviesRaw = curl.exe -s "$GatewayUrl/top-movies"
$TopMovies = $TopMoviesRaw | ConvertFrom-Json

Assert-True ($TopMovies.source -eq "grpc") "Gateway /top-movies uses gRPC source"
Assert-True ($TopMovies.grpcAnalyticsEnabled -eq $true) "Gateway /top-movies reports gRPC enabled"
Assert-True ($null -eq $TopMovies.lastGrpcError) "Gateway reports no gRPC error"

Write-Step "Checking gateway metrics expose gRPC state"

$MetricsRaw = curl.exe -s "$GatewayUrl/metrics"
$Metrics = $MetricsRaw | ConvertFrom-Json

Assert-True ($Metrics.state.topMoviesSource -eq "grpc") "Gateway metrics report topMoviesSource=grpc"
Assert-True ($Metrics.state.grpcAnalyticsEnabled -eq $true) "Gateway metrics report gRPC enabled"
Assert-True ($Metrics.state.grpcAnalyticsTargetConfigured -eq $true) "Gateway metrics report gRPC target configured"
Assert-True ($null -eq $Metrics.state.lastGrpcError) "Gateway metrics report no lastGrpcError"

Write-Step "Checking direct Node gRPC client"

Push-Location "grpc-analytics-service"

try {
  $ClientOutput = node client.js $GrpcUrl
  $ClientOutputText = $ClientOutput -join "`n"

  Assert-True ($ClientOutputText.Contains("Health response")) "Node gRPC client received Health response"
  Assert-True ($ClientOutputText.Contains("Top movies response")) "Node gRPC client received Top movies response"
  Assert-True ($ClientOutputText.Contains("grpc-analytics-service")) "Node gRPC client reached grpc-analytics-service"
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "gRPC analytics verification completed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Verified internal communication:"
Write-Host "websocket-gateway -> gRPC -> grpc-analytics-service -> Firestore"
Write-Host ""