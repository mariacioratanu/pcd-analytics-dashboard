param(
  [string]$Region = "us-central1",
  [string]$MovieId = "573a1390f29313caabcd42e8",
  [int]$Requests = 20,
  [int]$WaitSeconds = 15,
  [string]$OutputDir = "benchmark-results"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force $OutputDir | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ProjectId = gcloud config get-value project
$FastUrl = gcloud run services describe fast-lazy-bee --region $Region --format="value(status.url)"
$GatewayUrl = gcloud run services describe websocket-gateway --region $Region --format="value(status.url)"

Write-Host "Project: $ProjectId"
Write-Host "Fast Lazy Bee: $FastUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"
Write-Host "MovieId: $MovieId"
Write-Host "Requests: $Requests"

Write-Host "Resetting gateway runtime metrics..."
curl.exe -s -X POST -H "Content-Type: application/json" --data "{}" "$GatewayUrl/debug/reset" | Out-Null

Start-Sleep -Seconds 2

$StartUtc = (Get-Date).ToUniversalTime().ToString("o")
$Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$StatusCodes = @{}

for ($i = 1; $i -le $Requests; $i++) {
  $StatusCode = curl.exe -s -o NUL -w "%{http_code}" -H "Cache-Control: no-cache" "$FastUrl/api/v1/movies/$MovieId"

  if ($StatusCodes.ContainsKey($StatusCode)) {
    $StatusCodes[$StatusCode] += 1
  } else {
    $StatusCodes[$StatusCode] = 1
  }
}

$SuccessfulRequests = 0
$FailedRequests = 0

foreach ($Code in $StatusCodes.Keys) {
  if ($Code -match "^2\d\d$") {
    $SuccessfulRequests += $StatusCodes[$Code]
  } else {
    $FailedRequests += $StatusCodes[$Code]
  }
}

$ErrorRatePercent = if ($Requests -gt 0) {
  [Math]::Round(($FailedRequests / $Requests) * 100, 2)
} else {
  0
}

$Stopwatch.Stop()
$SendDurationMs = [Math]::Round($Stopwatch.Elapsed.TotalMilliseconds, 2)
$ApproxRequestRate = [Math]::Round($Requests / ($Stopwatch.Elapsed.TotalSeconds), 2)

Write-Host "Sent $Requests requests in $SendDurationMs ms (~$ApproxRequestRate req/s)"
Write-Host "Waiting $WaitSeconds seconds for asynchronous processing..."

Start-Sleep -Seconds $WaitSeconds

$SnapshotRaw = curl.exe -s "$GatewayUrl/snapshot"
$Snapshot = $SnapshotRaw | ConvertFrom-Json

$Result = [ordered]@{
  projectId = $ProjectId
  region = $Region
  movieId = $MovieId
  requests = $Requests
successfulRequests = $SuccessfulRequests
failedRequests = $FailedRequests
errorRatePercent = $ErrorRatePercent
httpStatusCodes = $StatusCodes
startedAtUtc = $StartUtc
sendDurationMs = $SendDurationMs
  approxRequestRatePerSecond = $ApproxRequestRate
  waitSeconds = $WaitSeconds
  gatewayUrl = $GatewayUrl
  fastUrl = $FastUrl
  snapshot = $Snapshot
}

$JsonPath = Join-Path $OutputDir "burst-$Timestamp.json"
$CsvPath = Join-Path $OutputDir "burst-summary-$Timestamp.csv"

$Result | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $JsonPath

$Summary = [pscustomobject]@{
  timestamp = $Timestamp
  requests = $Requests
successfulRequests = $SuccessfulRequests
failedRequests = $FailedRequests
errorRatePercent = $ErrorRatePercent
httpStatusCodes = ($StatusCodes.GetEnumerator() | ForEach-Object { "$($_.Key):$($_.Value)" }) -join ";"
sendDurationMs = $SendDurationMs
approxRequestRatePerSecond = $ApproxRequestRate
totalUpdates = $Snapshot.metrics.totalUpdates
  totalBroadcasts = $Snapshot.metrics.totalBroadcasts
  coalescedUpdates = $Snapshot.metrics.coalescedUpdates
  sampleCount = $Snapshot.metrics.sampleCount
  latestLatencyMs = $Snapshot.metrics.latestLatencyMs
  p50LatencyMs = $Snapshot.metrics.p50LatencyMs
  p95LatencyMs = $Snapshot.metrics.p95LatencyMs
  p99LatencyMs = $Snapshot.metrics.p99LatencyMs
  backpressureEnabled = $Snapshot.metrics.backpressureEnabled
  broadcastIntervalMs = $Snapshot.metrics.broadcastIntervalMs
  topMovieTitle = $Snapshot.topMovies[0].movieTitle
  topMovieViews = $Snapshot.topMovies[0].viewCount
}

$Summary | Export-Csv -NoTypeInformation -Encoding UTF8 $CsvPath

Write-Host "JSON result: $JsonPath"
Write-Host "CSV summary: $CsvPath"
Write-Host ""
Write-Host "Summary:"
$Summary | Format-List