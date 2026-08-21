import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy, checkBackend } from '../src/proxy.js';

test('proxy forwards method, headers, and body and returns backend status', async () => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-backend': 'yes' });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, body }));
    });
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const backendPort = backend.address().port;

  const proxy = startProxy({ port: 0, backend: `127.0.0.1:${backendPort}`, out: () => {} });
  await new Promise((r) => proxy.once('listening', r));

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/hello?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-test': 'pass' },
      body: 'ping'
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.headers.get('x-backend'), 'yes');
    const data = await res.json();
    assert.strictEqual(data.method, 'POST');
    assert.strictEqual(data.url, '/hello?x=1');
    assert.strictEqual(data.body, 'ping');
    assert.strictEqual(data.host, `127.0.0.1:${backendPort}`);
  } finally {
    proxy.close();
    await new Promise((r) => backend.close(r));
  }
});

test('proxy adds a Bearer Authorization header from the configured env var', async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization }));
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const backendPort = backend.address().port;

  const proxy = startProxy({ port: 0, backend: `127.0.0.1:${backendPort}`, bearer: 'API_KEY', out: () => {} });
  await new Promise((r) => proxy.once('listening', r));

  try {
    process.env.API_KEY = 'sekret';
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).auth, 'Bearer sekret');
  } finally {
    delete process.env.API_KEY;
    proxy.close();
    await new Promise((r) => backend.close(r));
  }
});

test('proxy returns 502 when the backend is unreachable', async () => {
  const proxy = startProxy({ port: 0, backend: '127.0.0.1:1', out: () => {} });
  await new Promise((r) => proxy.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/`);
    assert.strictEqual(res.status, 502);
    assert.match(await res.text(), /apic proxy error/);
  } finally {
    proxy.close();
  }
});

test('proxy startup message includes the process pid', async () => {
  const lines = [];
  const proxy = startProxy({ port: 0, backend: null, out: (m) => lines.push(m) });
  await new Promise((r) => proxy.once('listening', r));
  proxy.close();
  assert.ok(lines.some((l) => l.includes('pid') && l.includes(String(process.pid))));
});

test('checkBackend is true for a reachable address and false for an unreachable one', async () => {
  const backend = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const port = backend.address().port;
  try {
    assert.strictEqual(await checkBackend(`127.0.0.1:${port}`), true);
  } finally {
    await new Promise((r) => backend.close(r));
  }
  assert.strictEqual(await checkBackend('127.0.0.1:1'), false);
});

test('a bare -P port is resolved against localhost', async () => {
  const backend = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => backend.listen(0, r));
  const port = backend.address().port;
  assert.strictEqual(await checkBackend(String(port)), true);
  await new Promise((r) => backend.close(r));
});