param(
  [string]$Region = "us-central1",
  [string]$MovieId = "573a1390f29313caabcd42e8",
  [int]$Trials = 5,
  [int]$PollIntervalMs = 500,
  [int]$TimeoutSeconds = 30,
  [string]$OutputDir = "benchmark-results",
  [string]$DebugToken = $env:DEBUG_TOKEN
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
Write-Host "Trials: $Trials"

$Results = @()

for ($trial = 1; $trial -le $Trials; $trial++) {
  Write-Host ""
  Write-Host "Trial $trial/$Trials"
  Write-Host "Resetting gateway runtime metrics..."

  if ([string]::IsNullOrWhiteSpace($DebugToken)) {
  curl.exe -s -X POST -H "Content-Type: application/json" --data "{}" "$GatewayUrl/debug/reset" | Out-Null
} else {
  curl.exe -s -X POST -H "Content-Type: application/json" -H "x-debug-token: $DebugToken" --data "{}" "$GatewayUrl/debug/reset" | Out-Null
}
  Start-Sleep -Seconds 2

  $StartUtc = (Get-Date).ToUniversalTime()
  $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

  curl.exe -s -o NUL -H "Cache-Control: no-cache" "$FastUrl/api/v1/movies/$MovieId"

  $Detected = $false
  $Snapshot = $null

  while ($Stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    Start-Sleep -Milliseconds $PollIntervalMs

    $SnapshotRaw = curl.exe -s "$GatewayUrl/snapshot"
    $Snapshot = $SnapshotRaw | ConvertFrom-Json

    if ($Snapshot.metrics.totalUpdates -ge 1 -and $null -ne $Snapshot.lastProcessedUpdate) {
      $Detected = $true
      break
    }
  }

  $Stopwatch.Stop()

  $ConsistencyWindowMs = [Math]::Round($Stopwatch.Elapsed.TotalMilliseconds, 2)
  $Update = $Snapshot.lastProcessedUpdate
  $Metrics = $Snapshot.metrics

  $TrialResult = [pscustomobject]@{
    trial = $trial
    detected = $Detected
    consistencyWindowMs = $ConsistencyWindowMs
    totalUpdates = $Metrics.totalUpdates
    totalBroadcasts = $Metrics.totalBroadcasts
    coalescedUpdates = $Metrics.coalescedUpdates
    processingLatencyMs = $Update.processingLatencyMs
    gatewayLatencyMs = $Update.gatewayLatencyMs
    endToEndLatencyMs = $Update.endToEndLatencyMs
    movieTitle = $Update.movieTitle
    viewCount = $Update.viewCount
    startedAtUtc = $StartUtc.ToString("o")
    processedAt = $Update.processedAt
    gatewayReceivedAt = $Update.gatewayReceivedAt
  }

  $Results += $TrialResult

  Write-Host "Detected: $Detected"
  Write-Host "Consistency window: $ConsistencyWindowMs ms"
  Write-Host "End-to-end latency from payload: $($Update.endToEndLatencyMs) ms"
}

$Successful = $Results | Where-Object { $_.detected -eq $true }

$Summary = [pscustomobject]@{
  timestamp = $Timestamp
  projectId = $ProjectId
  region = $Region
  movieId = $MovieId
  trials = $Trials
  successfulTrials = $Successful.Count
  avgConsistencyWindowMs = if ($Successful.Count -gt 0) { [Math]::Round(($Successful | Measure-Object consistencyWindowMs -Average).Average, 2) } else { $null }
  minConsistencyWindowMs = if ($Successful.Count -gt 0) { ($Successful | Measure-Object consistencyWindowMs -Minimum).Minimum } else { $null }
  maxConsistencyWindowMs = if ($Successful.Count -gt 0) { ($Successful | Measure-Object consistencyWindowMs -Maximum).Maximum } else { $null }
  avgEndToEndLatencyMs = if ($Successful.Count -gt 0) { [Math]::Round(($Successful | Measure-Object endToEndLatencyMs -Average).Average, 2) } else { $null }
  avgProcessingLatencyMs = if ($Successful.Count -gt 0) { [Math]::Round(($Successful | Measure-Object processingLatencyMs -Average).Average, 2) } else { $null }
  avgGatewayLatencyMs = if ($Successful.Count -gt 0) { [Math]::Round(($Successful | Measure-Object gatewayLatencyMs -Average).Average, 2) } else { $null }
}

$JsonPath = Join-Path $OutputDir "consistency-$Timestamp.json"
$CsvPath = Join-Path $OutputDir "consistency-trials-$Timestamp.csv"
$SummaryPath = Join-Path $OutputDir "consistency-summary-$Timestamp.csv"

[ordered]@{
  summary = $Summary
  trials = $Results
} | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $JsonPath

$Results | Export-Csv -NoTypeInformation -Encoding UTF8 $CsvPath
$Summary | Export-Csv -NoTypeInformation -Encoding UTF8 $SummaryPath

Write-Host ""
Write-Host "JSON result: $JsonPath"
Write-Host "CSV trials: $CsvPath"
Write-Host "CSV summary: $SummaryPath"
Write-Host ""
Write-Host "Summary:"
$Summary | Format-List