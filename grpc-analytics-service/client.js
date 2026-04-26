const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const inputTarget = process.argv[2] || process.env.GRPC_ANALYTICS_URL || 'localhost:8080';
const protoPath = path.join(__dirname, 'proto', 'analytics.proto');
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const analyticsProto = grpc.loadPackageDefinition(packageDefinition).analytics;

function normalizeTarget(value) {
  if (value.startsWith('https://')) {
    const url = new URL(value);
    return {
      address: `${url.hostname}:443`,
      secure: true
    };
  }

  if (value.startsWith('http://')) {
    const url = new URL(value);
    return {
      address: `${url.hostname}:${url.port || 80}`,
      secure: false
    };
  }

  return {
    address: value,
    secure: !value.includes('localhost') && !value.startsWith('127.0.0.1')
  };
}

const target = normalizeTarget(inputTarget);
const credentials = target.secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
const client = new analyticsProto.AnalyticsService(target.address, credentials);

function callHealth() {
  return new Promise((resolve, reject) => {
    client.Health({}, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(response);
    });
  });
}

function callTopMovies(limit) {
  return new Promise((resolve, reject) => {
    client.GetTopMovies({ limit }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(response);
    });
  });
}

async function main() {
  console.log(`Calling gRPC target: ${target.address}`);
  console.log(`Secure connection: ${target.secure}`);

  const health = await callHealth();
  console.log('');
  console.log('Health response:');
  console.log(JSON.stringify(health, null, 2));

  const topMovies = await callTopMovies(10);
  console.log('');
  console.log('Top movies response:');
  console.log(JSON.stringify(topMovies, null, 2));
}

main().catch((error) => {
  console.error('gRPC client failed:');
  console.error(error);
  process.exit(1);
});