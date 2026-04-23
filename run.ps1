#!/usr/bin/env pwsh

# Load environment variables
Copy-Item -Path ".env.sample" -Destination ".env"
Get-Content .env | foreach {
    $name, $value = $_.split('=')
    if (-not(($name.Contains('#') -or $name -eq ''))) {
        [System.Environment]::SetEnvironmentVariable($name, $value)
    }
}
Get-Content ".env"

Set-Content env:SAMPLE_DATA_ARCHIVE_LOCATION "$env:TMP\sampledata.archive"

# Check local environment
Write-Output "> Checking local environment..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Output "> Node.js is not installed! Please install Node.js."
    exit 1
} elseif (-not (Get-Command mongorestore -ErrorAction SilentlyContinue)) {
    Write-Output "> mongorestore is not installed! Please install mongodb-database-tools."
    exit 1
} elseif (-not (Get-Command curl -ErrorAction SilentlyContinue)) {
    Write-Output "> cURL is not installed! Please install cURL."
    exit 1
}
Write-Output "> Local environment is ready!"

# Download the official MongoDB sample data archive (dump) from AWS S3
if (-not (Test-Path $env:SAMPLE_DATA_ARCHIVE_LOCATION)) {
    Write-Output "> Downloading the official MongoDB sample data archive (dump) from AWS S3..."
    Start-BitsTransfer -Source "https://atlas-education.s3.amazonaws.com/sampledata.archive" -Destination $env:SAMPLE_DATA_ARCHIVE_LOCATION
    Write-Output "> Sample data archive downloaded successfully!"
}

# Restore the sample data archive into the local MongoDB instance
Write-Output "> Restoring sample data into MongoDB..."
mongorestore --uri="mongodb://localhost:$env:MONGO_PORT/" --archive=$env:SAMPLE_DATA_ARCHIVE_LOCATION --drop

Write-Output "> Initial data loaded successfully!"

# Install dependencies and start the app
Write-Output "> Installing dependencies..."
npm ci

Write-Output "> Building the application..."
npm run build

Write-Output "> Starting FastLazyBee..."
Write-Output "> You can access the API at http://localhost:$env:APP_PORT/docs"
npm start
