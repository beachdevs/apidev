import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchWS, matchesExpectation, reconnectDelay } from '../src/fetch.js';
import { runCli } from '../src/cli.js';

const configFile = (yaml) => {
  const dir = mkdtempSync(join(tmpdir(), 'apicat-ws-'));
  const path = join(dir, 'apicat.yaml');
  writeFileSync(path, yaml);
  return { dir, path };
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static behavior = () => {};
  static maxOpen = 0;
  static openCount = 0;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = { open: [], message: [], close: [], error: [] };
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      FakeWebSocket.openCount += 1;
      FakeWebSocket.maxOpen = Math.max(FakeWebSocket.maxOpen, FakeWebSocket.openCount);
      FakeWebSocket.behavior(this);
      this.emit('open', {});
    });
  }

  addEventListener(type, fn, options = {}) {
    const wrapped = options.once ? (...args) => {
      this.listeners[type] = this.listeners[type].filter(listener => listener !== wrapped);
      fn(...args);
    } : fn;
    this.listeners[type].push(wrapped);
  }

  emit(type, event) {
    for (const fn of [...this.listeners[type]]) fn(event);
  }

  receive(value) {
    this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  send(value) {
    this.sent.push(value);
  }

  close(code, reason) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    if (this.readyState === FakeWebSocket.OPEN) FakeWebSocket.openCount -= 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
}

const withFakeWebSocket = (t, behavior = () => {}) => {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = behavior;
  FakeWebSocket.maxOpen = 0;
  FakeWebSocket.openCount = 0;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  return FakeWebSocket;
};

test('WebSocket request/response behavior resolves normally', async (t) => {
  withFakeWebSocket(t, (ws) => {
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      ws.receive({ echo: value });
      ws.close();
    };
  });
  const { dir, path } = configFile(`
echo.ws:
  url: wss://example.test/echo
  body: hello
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const messages = [];

  await fetchWS('echo', 'ws', { configPath: path, onMessage: msg => messages.push(msg) });

  assert.deepStrictEqual(messages, [{ echo: 'hello' }]);
  assert.deepStrictEqual(FakeWebSocket.instances.map(ws => ws.url), ['wss://example.test/echo']);
});

test('CLI prints prefixed WebSocket connection status to stderr', async (t) => {
  withFakeWebSocket(t, (ws) => {
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      ws.receive({ echo: value });
      ws.close(4001, 'done');
    };
  });
  const { dir, path } = configFile(`
status.ws:
  url: wss://example.test/status
  body: hello
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = [];
  const errors = [];

  const code = await runCli(['--config', path, 'status.ws'], {
    out: value => output.push(value),
    err: value => errors.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(output, ['{"echo":"hello"}']);
  assert.deepStrictEqual(errors, ['# Connected to: wss://example.test/status', '# Disconnected (4001 done)']);
});

test('multi-step WebSocket flow reuses the existing socket and captures values', async (t) => {
  withFakeWebSocket(t, (ws) => {
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      if (value === 'first') ws.receive({ token: 'abc' });
      if (value === 'second abc') ws.close();
    };
  });
  const { dir, path } = configFile(`
flow.demo:
  url: wss://example.test/flow
flow.demo.1:
  body: first
  keep_alive: true
  capture:
    token: .token
flow.demo.2:
  body: second $token
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await fetchWS('flow', 'demo', { configPath: path });

  assert.strictEqual(FakeWebSocket.instances.length, 1);
  assert.deepStrictEqual(FakeWebSocket.instances[0].sent, ['first', 'second abc']);
});

test('fixed heartbeat interval sends configured messages and accepts expected acknowledgements', async (t) => {
  withFakeWebSocket(t, (ws) => {
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      const parsed = JSON.parse(value);
      if (parsed.type === 'ping') {
        ws.receive({ type: 'pong' });
        ws.close();
      }
    };
  });
  const { dir, path } = configFile(`
hb.fixed:
  url: wss://example.test/hb
  keep_alive:
    interval: 0.005
    send:
      type: ping
    expect:
      type: pong
    timeout: 0.05
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await fetchWS('hb', 'fixed', { configPath: path });

  assert.deepStrictEqual(FakeWebSocket.instances[0].sent.map(JSON.parse), [{ type: 'ping' }]);
});

test('heartbeat messages resolve variables and captured values', async (t) => {
  withFakeWebSocket(t, (ws) => {
    ws.receive({ seq: 7, hb: 0.005 });
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      const parsed = JSON.parse(value);
      if (parsed.type === 'ping') {
        ws.receive({ type: 'pong' });
        ws.close();
      }
    };
  });
  const { dir, path } = configFile(`
hb.capture:
  url: wss://example.test/hb
  capture:
    sequence: .seq
    heartbeat_interval: .hb
  keep_alive:
    interval: $heartbeat_interval
    send:
      type: ping
      token: $TOKEN
      d: $sequence
    expect:
      type: pong
    timeout: 0.05
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await fetchWS('hb', 'capture', { vars: { TOKEN: 'secret' }, configPath: path });

  assert.deepStrictEqual(FakeWebSocket.instances[0].sent.map(JSON.parse), [{ type: 'ping', token: 'secret', d: '7' }]);
});

test('server-supplied heartbeat intervals survive acknowledgements without interval fields', async (t) => {
  withFakeWebSocket(t, (ws) => {
    ws.receive({ op: 10, d: { heartbeat_interval: 5 }, s: null });
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      const parsed = JSON.parse(value);
      if (parsed.op === 1) ws.receive({ op: 11, d: null, s: null });
    };
  });
  const { dir, path } = configFile(`
gateway.listen:
  url: wss://example.test/gateway
  capture:
    sequence: .s // empty
    heartbeat_interval: if .d.heartbeat_interval? then (.d.heartbeat_interval / 1000) else empty end
  keep_alive:
    interval: $heartbeat_interval
    send:
      op: 1
      d: $sequence
    expect:
      op: 11
    timeout: 0.05
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let acks = 0;

  await fetchWS('gateway', 'listen', {
    configPath: path,
    onMessage: (msg, ctx) => {
      if (msg.op === 11 && ++acks === 3) ctx.close();
    }
  });

  assert.deepStrictEqual(FakeWebSocket.instances[0].sent.map(JSON.parse), [
    { op: 1, d: null },
    { op: 1, d: null },
    { op: 1, d: null }
  ]);
});

test('empty capture output does not overwrite existing capture values', async (t) => {
  withFakeWebSocket(t, (ws) => {
    ws.receive({ token: 'abc' });
    ws.receive({ other: true });
    ws.close();
  });
  const { dir, path } = configFile(`
capture.keep:
  url: wss://example.test/capture
  capture:
    token: .token // empty
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const captures = [];

  await fetchWS('capture', 'keep', {
    configPath: path,
    onMessage: (_msg, ctx) => captures.push(ctx.captures.token)
  });

  assert.deepStrictEqual(captures, ['abc', 'abc']);
});

test('liveness timeout rejects when the expected heartbeat acknowledgement is missing', async (t) => {
  withFakeWebSocket(t);
  const { dir, path } = configFile(`
hb.dead:
  url: wss://example.test/dead
  keep_alive:
    interval: 0.005
    send:
      type: ping
    expect:
      type: pong
    timeout: 0.005
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    fetchWS('hb', 'dead', { configPath: path }),
    /WebSocket liveness timeout/
  );
});

test('unexpected close reconnects when enabled and does not create duplicate connections', async (t) => {
  withFakeWebSocket(t, (ws) => {
    if (FakeWebSocket.instances.length === 1) {
      ws.close();
    } else {
      ws.receive({ ready: true });
    }
  });
  const { dir, path } = configFile(`
listen.ws:
  url: wss://example.test/listen
  keep_alive: true
  reconnect:
    enabled: true
    initial: 0.001
    maximum: 0.001
    multiplier: 2
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await fetchWS('listen', 'ws', {
    configPath: path,
    onMessage: (_msg, ctx) => ctx.close()
  });

  assert.strictEqual(FakeWebSocket.instances.length, 2);
  assert.strictEqual(FakeWebSocket.maxOpen, 1);
});

test('reconnect disabled does not reconnect a long-lived socket', async (t) => {
  withFakeWebSocket(t, (ws) => ws.close());
  const { dir, path } = configFile(`
listen.ws:
  url: wss://example.test/listen
  keep_alive: true
  reconnect:
    enabled: false
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await fetchWS('listen', 'ws', { configPath: path });

  assert.strictEqual(FakeWebSocket.instances.length, 1);
});

test('reconnect uses exponential backoff and jitter', () => {
  const policy = { initial: 1, maximum: 60, multiplier: 2, jitter: 0 };
  assert.strictEqual(reconnectDelay(policy, 0), 1);
  assert.strictEqual(reconnectDelay(policy, 1), 2);
  assert.strictEqual(reconnectDelay(policy, 10), 60);
  assert.strictEqual(reconnectDelay({ ...policy, jitter: 0.2 }, 2, () => 1), 4.8);
  assert.strictEqual(reconnectDelay({ ...policy, jitter: 0.2 }, 2, () => 0), 3.2);
});

test('object expectation matching supports nested partial matches', () => {
  assert.equal(matchesExpectation({ op: 11, extra: true }, { op: 11 }), true);
  assert.equal(matchesExpectation({ d: { status: 'alive', ignored: true } }, { d: { status: 'alive' } }), true);
  assert.equal(matchesExpectation({ d: { status: 'dead' } }, { d: { status: 'alive' } }), false);
});

test('heartbeat timers are not duplicated after reconnect', async (t) => {
  withFakeWebSocket(t, (ws) => {
    if (FakeWebSocket.instances.length === 1) {
      ws.close();
      return;
    }
    const originalSend = ws.send.bind(ws);
    ws.send = (value) => {
      originalSend(value);
      const parsed = JSON.parse(value);
      if (parsed.type === 'ping') {
        ws.receive({ type: 'pong' });
      }
    };
  });
  const { dir, path } = configFile(`
hb.reconnect:
  url: wss://example.test/hb
  keep_alive:
    interval: 0.005
    send:
      type: ping
    expect:
      type: pong
    timeout: 0.05
  reconnect:
    enabled: true
    initial: 0.001
    maximum: 0.001
    multiplier: 2
`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let pongs = 0;

  await fetchWS('hb', 'reconnect', {
    configPath: path,
    onMessage: (_msg, ctx) => {
      pongs += 1;
      if (pongs === 2) ctx.close();
    }
  });

  assert.strictEqual(FakeWebSocket.instances.length, 2);
  assert.deepStrictEqual(FakeWebSocket.instances[1].sent.map(JSON.parse), [{ type: 'ping' }, { type: 'ping' }]);
});
