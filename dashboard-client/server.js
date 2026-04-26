const fs = require('fs');
const http = require('http');
const path = require('path');
const PORT = process.env.PORT || 8080;
const WS_URL = process.env.WS_URL || '';
const PUBLIC_DIR = __dirname;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStaticFile(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === '/') {
    pathname = '/index.html';
  }

  if (pathname === '/config.js') {
    const config = `window.DASHBOARD_CONFIG = ${JSON.stringify({ wsUrl: WS_URL })};\n`;
    send(res, 200, config, 'application/javascript; charset=utf-8');
    return;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = contentTypes[ext] || 'application/octet-stream';
    send(res, 200, data, contentType);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    send(
      res,
      200,
      JSON.stringify({
        status: 'ok',
        service: 'dashboard-client',
        wsUrlConfigured: Boolean(WS_URL)
      }),
      'application/json; charset=utf-8'
    );
    return;
  }

  serveStaticFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Dashboard client running on port ${PORT}`);
  console.log(`Configured WS_URL=${WS_URL}`);
});