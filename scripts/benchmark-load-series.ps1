param(
  [string]$Region = "us-central1",
  [string]$MovieId = "573a1390f29313caabcd42e8",
  [string]$RequestCounts = "10,20,50,100",
  [int]$WaitSeconds = 25,
  [string]$OutputDir = "benchmark-results"
)

$ErrorActionPreference = "Stop"

$ParsedRequestCounts = $RequestCounts -split "," | ForEach-Object {
  $value = $_.Trim()

  if ($value -notmatch "^\d+$") {
    throw "Invalid request count value: '$value'. Use format like: -RequestCounts `"10,20,50`""
  }

  [int]$value
}

if ($ParsedRequestCounts.Count -eq 1 -and $ParsedRequestCounts[0] -gt 1000) {
  throw "RequestCounts was parsed as $($ParsedRequestCounts[0]). This is probably a mistake. Use quotes like: -RequestCounts `"10,20,50`""
}

New-Item -ItemType Directory -Force $OutputDir | Out-Null

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$CombinedResults = @()

Write-Host "Running variable-load benchmark series..."
Write-Host "Request counts: $($ParsedRequestCounts -join ', ')"
Write-Host "WaitSeconds per run: $WaitSeconds"

foreach ($RequestCount in $ParsedRequestCounts) {
  Write-Host ""
  Write-Host "========================================"
  Write-Host "Running load level: $RequestCount requests"
  Write-Host "========================================"

  powershell.exe -ExecutionPolicy Bypass -File .\scripts\benchmark-burst.ps1 -Region $Region -MovieId $MovieId -Requests $RequestCount -WaitSeconds $WaitSeconds

  $LatestSummary = Get-ChildItem $OutputDir -Filter "burst-summary-*.csv" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($null -eq $LatestSummary) {
    throw "No burst summary CSV was generated."
  }

  $Row = Import-Csv $LatestSummary.FullName | Select-Object -First 1

  $ProcessedUpdates = [int]$Row.totalUpdates
  $ExpectedRequests = [int]$Row.requests

  $CompletionPercent = if ($ExpectedRequests -gt 0) {
    [Math]::Round(($ProcessedUpdates / $ExpectedRequests) * 100, 2)
  } else {
    0
  }

  $ObservedUpdateRate = if ($WaitSeconds -gt 0) {
    [Math]::Round($ProcessedUpdates / $WaitSeconds, 2)
  } else {
    0
  }

  $CombinedResults += [pscustomobject]@{
    timestamp = $Row.timestamp
    requests = $Row.requests
    successfulRequests = $Row.successfulRequests
    failedRequests = $Row.failedRequests
    errorRatePercent = $Row.errorRatePercent
    httpStatusCodes = $Row.httpStatusCodes
    sendDurationMs = $Row.sendDurationMs
    approxRequestRatePerSecond = $Row.approxRequestRatePerSecond
    totalUpdates = $Row.totalUpdates
    processingCompletionPercent = $CompletionPercent
    observedUpdateRatePerSecond = $ObservedUpdateRate
    totalBroadcasts = $Row.totalBroadcasts
    coalescedUpdates = $Row.coalescedUpdates
    sampleCount = $Row.sampleCount
    latestLatencyMs = $Row.latestLatencyMs
    p50LatencyMs = $Row.p50LatencyMs
    p95LatencyMs = $Row.p95LatencyMs
    p99LatencyMs = $Row.p99LatencyMs
    backpressureEnabled = $Row.backpressureEnabled
    broadcastIntervalMs = $Row.broadcastIntervalMs
    topMovieTitle = $Row.topMovieTitle
    topMovieViews = $Row.topMovieViews
  }
}

$CombinedCsvPath = Join-Path $OutputDir "load-series-summary-$Timestamp.csv"
$CombinedJsonPath = Join-Path $OutputDir "load-series-summary-$Timestamp.json"

$CombinedResults | Export-Csv -NoTypeInformation -Encoding UTF8 $CombinedCsvPath
$CombinedResults | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $CombinedJsonPath

Write-Host ""
Write-Host "Variable-load benchmark completed."
Write-Host "Combined CSV: $CombinedCsvPath"
Write-Host "Combined JSON: $CombinedJsonPath"
Write-Host ""
Write-Host "Combined summary:"
$CombinedResults | Format-Table -AutoSize