param(
  [string]$Region = "us-central1",
  [string]$MovieId = "573a1390f29313caabcd42e8",
  [int]$Requests = 100,
  [string]$ConcurrencyLevels = "1,5,10,20",
  [int]$WaitSeconds = 45,
  [string]$OutputDir = "benchmark-results",
  [string]$DebugToken = $env:DEBUG_TOKEN,
  [string]$HeyPath = "hey"
)

$ErrorActionPreference = "Stop"

function Convert-ToNumberOrNull {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $normalized = $Value.Trim().Replace(",", ".")

  try {
    return [double]::Parse($normalized, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    return $null
  }
}

function Get-RegexNumber {
  param(
    [string]$Text,
    [string]$Pattern
  )

  $match = [regex]::Match($Text, $Pattern)

  if (-not $match.Success) {
    return $null
  }

  return Convert-ToNumberOrNull $match.Groups[1].Value
}

function Get-StatusCount {
  param(
    [string]$Text,
    [string]$StatusCode
  )

  $pattern = "\[$StatusCode\]\s+(\d+)\s+responses"
  $match = [regex]::Match($Text, $pattern)

  if (-not $match.Success) {
    return 0
  }

  return [int]$match.Groups[1].Value
}

$ParsedConcurrencyLevels = $ConcurrencyLevels -split "," | ForEach-Object {
  $value = $_.Trim()

  if ($value -notmatch "^\d+$") {
    throw "Invalid concurrency value: '$value'. Use format like: -ConcurrencyLevels `"1,5,10,20`""
  }

  [int]$value
}

New-Item -ItemType Directory -Force $OutputDir | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ProjectId = gcloud config get-value project
$FastUrl = gcloud run services describe fast-lazy-bee --region $Region --format="value(status.url)"
$GatewayUrl = gcloud run services describe websocket-gateway --region $Region --format="value(status.url)"
$TargetUrl = "$FastUrl/api/v1/movies/$MovieId"

Write-Host "Running concurrency benchmark..."
Write-Host "Project: $ProjectId"
Write-Host "Region: $Region"
Write-Host "Fast Lazy Bee: $FastUrl"
Write-Host "WebSocket Gateway: $GatewayUrl"
Write-Host "Target URL: $TargetUrl"
Write-Host "Requests per run: $Requests"
Write-Host "Concurrency levels: $($ParsedConcurrencyLevels -join ', ')"
Write-Host "WaitSeconds per run: $WaitSeconds"
Write-Host "hey executable: $HeyPath"

$CombinedResults = @()

foreach ($Concurrency in $ParsedConcurrencyLevels) {
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Running concurrency level: $Concurrency"
  Write-Host "========================================"

  Write-Host "Resetting gateway runtime metrics..."

  if ([string]::IsNullOrWhiteSpace($DebugToken)) {
    curl.exe -s -X POST -H "Content-Type: application/json" --data "{}" "$GatewayUrl/debug/reset" | Out-Null
  } else {
    curl.exe -s -X POST -H "Content-Type: application/json" -H "x-debug-token: $DebugToken" --data "{}" "$GatewayUrl/debug/reset" | Out-Null
  }

  Start-Sleep -Seconds 2

  $StartedAtUtc = (Get-Date).ToUniversalTime().ToString("o")

  Write-Host "Running hey: $Requests requests, concurrency $Concurrency"

  $HeyOutput = & $HeyPath -n $Requests -c $Concurrency -H "Cache-Control: no-cache" $TargetUrl 2>&1
  $HeyText = $HeyOutput -join "`n"

  Write-Host $HeyText

  $HeyTotalSeconds = Get-RegexNumber $HeyText "Total:\s+([\d\.]+)\s+secs"
  $HeySlowestSeconds = Get-RegexNumber $HeyText "Slowest:\s+([\d\.]+)\s+secs"
  $HeyFastestSeconds = Get-RegexNumber $HeyText "Fastest:\s+([\d\.]+)\s+secs"
  $HeyAverageSeconds = Get-RegexNumber $HeyText "Average:\s+([\d\.]+)\s+secs"
  $HeyRequestsPerSecond = Get-RegexNumber $HeyText "Requests/sec:\s+([\d\.]+)"
  $Http200Responses = Get-StatusCount $HeyText "200"
  $FailedRequests = [Math]::Max(0, $Requests - $Http200Responses)
  $ErrorRatePercent = if ($Requests -gt 0) { [Math]::Round(($FailedRequests / $Requests) * 100, 2) } else { 0 }

  Write-Host "Waiting $WaitSeconds seconds for asynchronous processing..."
  Start-Sleep -Seconds $WaitSeconds

  $SnapshotRaw = curl.exe -s "$GatewayUrl/snapshot"
  $Snapshot = $SnapshotRaw | ConvertFrom-Json

  $ProcessedUpdates = [int]$Snapshot.metrics.totalUpdates
  $CompletionPercent = if ($Requests -gt 0) { [Math]::Round(($ProcessedUpdates / $Requests) * 100, 2) } else { 0 }
  $ObservedUpdateRate = if ($WaitSeconds -gt 0) { [Math]::Round($ProcessedUpdates / $WaitSeconds, 2) } else { 0 }

  $RunResult = [pscustomobject]@{
    timestamp = $Timestamp
    projectId = $ProjectId
    region = $Region
    movieId = $MovieId
    requests = $Requests
    concurrency = $Concurrency
    http200Responses = $Http200Responses
    failedRequests = $FailedRequests
    errorRatePercent = $ErrorRatePercent
    heyTotalSeconds = $HeyTotalSeconds
    heySlowestSeconds = $HeySlowestSeconds
    heyFastestSeconds = $HeyFastestSeconds
    heyAverageSeconds = $HeyAverageSeconds
    heyRequestsPerSecond = $HeyRequestsPerSecond
    totalUpdates = $Snapshot.metrics.totalUpdates
    processingCompletionPercent = $CompletionPercent
    observedUpdateRatePerSecond = $ObservedUpdateRate
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
    startedAtUtc = $StartedAtUtc
  }

  $CombinedResults += $RunResult

  $RunJsonPath = Join-Path $OutputDir "concurrency-run-c$Concurrency-$Timestamp.json"

  [ordered]@{
    run = $RunResult
    heyOutput = $HeyText
    snapshot = $Snapshot
  } | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $RunJsonPath

  Write-Host ""
  Write-Host "Run JSON result: $RunJsonPath"
  Write-Host "Run summary:"
  $RunResult | Format-List
}

$CombinedCsvPath = Join-Path $OutputDir "concurrency-summary-$Timestamp.csv"
$CombinedJsonPath = Join-Path $OutputDir "concurrency-summary-$Timestamp.json"

$CombinedResults | Export-Csv -NoTypeInformation -Encoding UTF8 $CombinedCsvPath
$CombinedResults | ConvertTo-Json -Depth 30 | Set-Content -Encoding UTF8 $CombinedJsonPath

Write-Host ""
Write-Host "Concurrency benchmark completed."
Write-Host "Combined CSV: $CombinedCsvPath"
Write-Host "Combined JSON: $CombinedJsonPath"
Write-Host ""
Write-Host "Combined summary:"
$CombinedResults | Format-Table -AutoSize