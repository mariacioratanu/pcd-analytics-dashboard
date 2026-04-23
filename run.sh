#!/usr/bin/env bash

# Load environment variables
cp .env.sample .env
. ./.env

SAMPLE_DATA_ARCHIVE_LOCATION=/tmp/sampledata.archive

# Check local environment
echo "> Checking local environment..."
if [ ! -x "$(command -v node)" ]; then
    echo "> Node.js is not installed! Please install Node.js."
    exit 1
elif [ ! -x "$(command -v mongod)" ] && [ ! -x "$(command -v mongosh)" ]; then
    echo "> MongoDB does not appear to be installed! Please install MongoDB."
    exit 1
elif [ ! -x "$(command -v mongorestore)" ]; then
    echo "> mongorestore is not installed! Please install mongodb-database-tools."
    exit 1
elif [ ! -x "$(command -v curl)" ]; then
    echo "> cURL is not installed! Please install cURL."
    exit 1
fi
echo "> Local environment is ready!"

# Download the official MongoDB sample data archive (dump) from AWS S3
if [ ! -f $SAMPLE_DATA_ARCHIVE_LOCATION ]; then
    echo "> Downloading the official MongoDB sample data archive (dump) from AWS S3..."
    curl https://atlas-education.s3.amazonaws.com/sampledata.archive > $SAMPLE_DATA_ARCHIVE_LOCATION
    echo "> Sample data archive downloaded successfully!"
fi

# Restore the sample data archive into the local MongoDB instance
echo "> Restoring sample data into MongoDB..."
mongorestore --uri="mongodb://localhost:${MONGO_PORT}/" --archive=$SAMPLE_DATA_ARCHIVE_LOCATION --drop

echo "> Initial data loaded successfully!"

# Install dependencies and start the app
echo "> Installing dependencies..."
npm ci

echo "> Building the application..."
npm run build

echo "> Starting FastLazyBee..."
echo "> You can access the API at http://localhost:${APP_PORT}/docs"
npm start
