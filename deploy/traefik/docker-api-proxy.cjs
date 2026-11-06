const http = require('node:http');

const allowed = /^\/(?:v\d+\.\d+\/)?(?:_ping|version|info|events|containers\/json|containers\/[a-zA-Z0-9_.-]+\/json|networks(?:\/[a-zA-Z0-9_.-]+)?)$/;
const metadata = /(?:\/containers\/(?:[a-zA-Z0-9_.-]+\/)?json|\/info)$/;

function removeSecrets(data) {
  if (Array.isArray(data)) {
    for (const row of data) delete row.Command;
    return data;
  }
  if (data.Config) {
    delete data.Config.Env;
    delete data.Config.Cmd;
    delete data.Config.Entrypoint;
  }
  delete data.Args;
  delete data.Path;
  delete data.LogPath;
  delete data.HTTPProxy;
  delete data.HTTPSProxy;
  delete data.RegistryConfig;
  return data;
}

http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url ?? '/', 'http://docker');
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)
    || !allowed.test(url.pathname)
    || request.headers['transfer-encoding']
    || Number(request.headers['content-length'] ?? 0) !== 0) {
    response.writeHead(403).end();
    return;
  }
  const upstream = http.request({
    socketPath: '/var/run/docker.sock',
    path: url.pathname + url.search,
    method: request.method,
    headers: { host: 'docker' },
  }, (incoming) => {
    incoming.once('error', () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    if (request.method !== 'GET' || incoming.statusCode !== 200 || !metadata.test(url.pathname)) {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
      return;
    }
    let size = 0;
    const chunks = [];
    incoming.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        incoming.destroy();
        response.writeHead(502).end();
      } else {
        chunks.push(chunk);
      }
    });
    incoming.once('end', () => {
      try {
        const body = JSON.stringify(removeSecrets(JSON.parse(Buffer.concat(chunks))));
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      } catch {
        response.writeHead(502).end();
      }
    });
  });
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy();
  });
  response.once('close', () => upstream.destroy());
  upstream.end();
}).listen(2375, '0.0.0.0');
