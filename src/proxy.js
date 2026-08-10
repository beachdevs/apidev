import http from 'node:http';
import https from 'node:https';

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const MAX_LOG = 64 * 1024;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

const resolveBackend = (backend) => !backend ? null : /^[a-z][a-z0-9+.-]*:\/\//i.test(backend) ? backend : `http://${backend}`;

const rawHeaders = (rawHeaders) => {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) lines.push(`  ${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  return lines.join('\n');
};

const bodyForLog = (buf) => {
  if (!buf.length) return '  (no body)';
  const head = buf.subarray(0, 4096);
  const binary = head.includes(0) || head.some((b) => (b < 9 || (b > 13 && b < 32)) && b !== 27);
  if (binary) return `  (binary body, ${buf.length} bytes)`;
  return buf.toString('utf8').split('\n').map((l) => `  ${l}`).join('\n');
};

// Capture body bytes for display without blocking the stream (capped at MAX_LOG).
const capture = (stream, limit = MAX_LOG) => {
  const chunks = [];
  let size = 0;
  let truncated = false;
  stream.on('data', (c) => {
    if (size >= limit) {
      truncated = true;
      return;
    }
    const take = Math.min(c.length, limit - size);
    chunks.push(c.subarray(0, take));
    size += take;
    if (take < c.length) truncated = true;
  });
  return {
    buffer: () => Buffer.concat(chunks),
    truncated: () => truncated
  };
};

export function startProxy({ port = 8080, backend, out = console.log } = {}) {
  const base = resolveBackend(backend);
  const server = http.createServer((req, res) => {
    const requested = req.url.startsWith('http')
      ? new URL(req.url)
      : new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const target = base ? new URL(`${requested.pathname}${requested.search}`, base) : requested;
    const headers = { ...req.headers, host: target.host };
    for (const h of hopByHop) delete headers[h];
    const transport = target.protocol === 'https:' ? https : http;
    const reqLog = capture(req);

    req.on('end', () => {
      const buf = reqLog.buffer();
      out(`${dim('→')} ${req.method} ${req.url} ${req.httpVersion}\n${rawHeaders(req.rawHeaders)}${buf.length ? `\n${bodyForLog(buf)}` : '\n  (no body)'}${reqLog.truncated() ? dim('\n  …truncated') : ''}\n`);
    });

    const preq = transport.request(target, { method: req.method, headers }, (pres) => {
      const resHeadersRaw = [...pres.rawHeaders];
      const resHeaders = { ...pres.headers };
      for (const h of hopByHop) delete resHeaders[h];
      res.writeHead(pres.statusCode, pres.statusMessage, resHeaders);
      const resLog = capture(pres);
      pres.pipe(res);
      pres.on('end', () => {
        const buf = resLog.buffer();
        out(`${dim('←')} ${pres.statusCode} ${pres.statusMessage ?? ''} ${pres.httpVersion}\n${rawHeaders(resHeadersRaw)}${buf.length ? `\n${bodyForLog(buf)}` : '\n  (no body)'}${resLog.truncated() ? dim('\n  …truncated') : ''}\n`);
      });
      pres.on('error', () => res.destroy());
    });
    preq.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`apic proxy error: ${e.message}\n`);
      out(`${dim('←')} 502 Bad Gateway\n  content-type: text/plain\n  (apic proxy error: ${e.message})\n`);
    });
    req.on('error', () => preq.destroy());
    req.pipe(preq);
  });
  server.on('clientError', (_e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(port, () => out(`apic proxy listening on :${port}${base ? ` -> ${base}` : ''}`));
  return server;
}