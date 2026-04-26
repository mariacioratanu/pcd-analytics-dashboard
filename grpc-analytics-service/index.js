const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { Firestore } = require('@google-cloud/firestore');
const PORT = process.env.PORT || 8080;
const ANALYTICS_COLLECTION = process.env.ANALYTICS_COLLECTION || 'movie-stats';
const DEFAULT_TOP_MOVIES_LIMIT = Number.parseInt(process.env.TOP_MOVIES_LIMIT || '10', 10);
const firestore = new Firestore();
const protoPath = path.join(__dirname, 'proto', 'analytics.proto');
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const analyticsProto = grpc.loadPackageDefinition(packageDefinition).analytics;

function nowIso() {
  return new Date().toISOString();
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TOP_MOVIES_LIMIT;
  }

  return Math.min(parsed, 50);
}

async function health(call, callback) {
  callback(null, {
    status: 'ok',
    service: 'grpc-analytics-service',
    generatedAt: nowIso()
  });
}

async function getTopMovies(call, callback) {
  try {
    const limit = normalizeLimit(call.request.limit);

    const snapshot = await firestore
      .collection(ANALYTICS_COLLECTION)
      .orderBy('viewCount', 'desc')
      .limit(limit)
      .get();

    const movies = snapshot.docs.map((doc) => {
      const data = doc.data();

      return {
        movieId: data.movieId || doc.id,
        movieTitle: data.movieTitle || 'Unknown movie',
        viewCount: Number(data.viewCount || 0),
        lastViewed: data.lastViewed || '',
        updatedAt: data.updatedAt || data.lastProcessedAt || ''
      };
    });

    callback(null, {
      movies,
      count: movies.length,
      generatedAt: nowIso()
    });
  } catch (error) {
    callback({
      code: grpc.status.INTERNAL,
      message: error.message
    });
  }
}

function main() {
  const server = new grpc.Server();

  server.addService(analyticsProto.AnalyticsService.service, {
    Health: health,
    GetTopMovies: getTopMovies
  });

  server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }

    console.log(`gRPC analytics service listening on port ${port}`);
    server.start();
  });
}

main();