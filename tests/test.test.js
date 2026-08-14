import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatResponse, runCli } from '../src/cli.js';
import { fetchApi, getApis, getRequest } from '../src/fetch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(root, 'apicat.yaml');
const uploadConfig = join(root, 'tests/fixtures/upload.yaml');
const uploadFile = join(root, 'tests/fixtures/upload-body.txt');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('cli usage includes the package version', async () => {
  const output = [];
  const code = await runCli([], { out: value => output.push(value) });

  assert.strictEqual(code, 0);
  assert.match(output.join('\n'), new RegExp(`apicat\\x1b\\[0m \\x1b\\[90mv${version} — call APIs`));
});

test('api help prints the YAML help text without making a request', async () => {
  const output = [];
  const code = await runCli(['-config', config, 'httpbin.get', '--help'], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(output, ['Send a GET request to httpbin.org/get.']);
});

test('update refuses to overwrite an existing config without confirmation', async () => {
  const errors = [];
  const code = await runCli(['update'], {
    err: value => errors.push(value),
    userConfigPath: config
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, [`Refusing to overwrite ${config} without confirmation. Run \`apic update\` in an interactive terminal.`]);
});

test('jq API field prints raw selected output', () => {
  const catfact = getApis(config).find(api => api.id === 'catfact.getFact');

  assert.strictEqual(catfact.jq, '.fact');
  assert.strictEqual(formatResponse('{"fact":"Cats purr."}', catfact.jq), 'Cats purr.');
});

test('JSON request bodies escape multiline variable values', () => {
  const prompt = 'First line\nA "quoted" path: C:\\temp';
  const req = getRequest('ollama', 'chat', {
    OLLAMA_MODEL: 'phi4:latest',
    PROMPT: prompt
  }, config);

  const body = JSON.parse(req.body);
  assert.strictEqual(body.model, 'phi4:latest');
  assert.strictEqual(body.messages[1].content, prompt);
});

test('file uploads read the configured local file as bytes', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init };
    return new Response('ok');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const req = getRequest('test', 'raw', { FILE: uploadFile }, uploadConfig);
  assert.strictEqual(req.file, uploadFile);
  await fetchApi('test', 'raw', { vars: { FILE: uploadFile }, configPath: uploadConfig });

  assert.strictEqual(request.url, 'https://upload.example/raw');
  assert.ok(Buffer.isBuffer(request.body));
  assert.strictEqual(request.body.toString(), 'binary-safe upload body\n');
});

test('multipart uploads support file and text fields', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init };
    return new Response('ok');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchApi('test', 'multipart', {
    vars: { FILE: uploadFile, DESCRIPTION: 'An upload' },
    configPath: uploadConfig
  });

  assert.strictEqual(request.url, 'https://upload.example/multipart');
  assert.ok(request.body instanceof FormData);
  assert.strictEqual(await request.body.get('document').text(), 'binary-safe upload body\n');
  assert.strictEqual(request.body.get('document').name, 'upload-body.txt');
  assert.strictEqual(request.body.get('description'), 'An upload');
});

test('download output writes response bytes to FILE_PATH', async (t) => {
  const originalFetch = globalThis.fetch;
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-download-'));
  const filePath = join(tempDir, 'download.bin');
  globalThis.fetch = async () => new Response(new Uint8Array([0, 1, 2, 255]));
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const output = [];
  const code = await runCli(['--config', uploadConfig, 'test.download', `FILE_PATH=${filePath}`], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual([...readFileSync(filePath)], [0, 1, 2, 255]);
  assert.deepStrictEqual(output, [filePath]);
});

test('cli.js module and apicli executable list APIs', async () => {
  const moduleOut = [];
  const moduleErr = [];
  const code = await runCli(['-config', config, 'ls'], {
    out: (...args) => moduleOut.push(args.join(' ')),
    err: (...args) => moduleErr.push(args.join(' '))
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(moduleErr, []);
  assert.strictEqual(moduleOut[0], '');
  assert.match(moduleOut.join('\n'), /\x1b\[36mhttpbin\.get\x1b\[0m/);
  assert.strictEqual(moduleOut.at(-1), '');

  const executable = spawnSync(process.execPath, [join(root, 'src/apicli'), '-config', config, 'ls'], {
    encoding: 'utf8',
    cwd: root
  });

  assert.strictEqual(executable.status, 0);
  assert.strictEqual(executable.stderr, '');
  assert.match(executable.stdout, /^\n\x1b\[36mbasert\.chat\x1b\[0m/m);
  assert.match(executable.stdout, /\n\n$/);
});

test('list output is alphabetically ordered by API ID', async () => {
  const output = [];
  const code = await runCli(['--config', config, 'ls'], { out: value => output.push(value) });
  const ids = output
    .filter(value => value.startsWith('\x1b[36m'))
    .map(value => value.replace(/^\x1b\[36m|\x1b\[0m$/g, ''));

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});
