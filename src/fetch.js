import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const userConfigPath = () => join(homedir(), '.apicat');
const bundledConfigPath = join(root, 'apicat.yaml');
const isReadableFile = (path) => {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
};
const resolveDefaultConfigPath = () => [userConfigPath(), bundledConfigPath].find(isReadableFile);

export const runJq = (q, input) => {
  const filter = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(String(q).trim()) ? `.${q}` : q;
  const r = spawnSync('jq', ['-r', filter], { input, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (r.error || r.status) throw new Error(r.stderr || r.error || `jq exited ${r.status}`);
  return r.stdout;
};

const parseId = (id) => {
  const parts = id.split('.');
  const service = parts.shift();
  const name = parts.join('.');
  const segs = name.split('.');
  const last = segs[segs.length - 1];
  const step = /^\d+$/.test(last) ? Number(last) : null;
  const base = step != null ? segs.slice(0, -1).join('.') : name;
  return { id, service, name, base, step };
};

const parseTxt = (c) => {
  const lines = c.trim().split('\n');
  const keys = lines.shift().trim().split(/\s+/);
  return { apis: lines.map(l => {
    const v = []; let cur = '', q = 0;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && l[i+1] === '"') { cur += '"'; i++; }
      else if (l[i] === '"') q = !q;
      else if (l[i] === ' ' && !q) { v.push(cur); cur = ''; }
      else cur += l[i];
    }
    const row = [...v, cur];
    return Object.fromEntries(keys.map((k, i) => {
      let val = row[i] === 'null' ? null : row[i];
      if (k !== 'body' && val?.startsWith?.('{')) try { val = JSON.parse(val); } catch(e){}
      return [k, val];
    }));
  }) };
};

const isInJsonString = (source, end) => {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < end; i++) {
    if (escaped) escaped = false;
    else if (source[i] === '\\') escaped = true;
    else if (source[i] === '"') inString = !inString;
  }
  return inString;
};

const sub = (s, v = {}, json = false) => s?.replace?.(/(\$\$)|(\$!?)([A-Za-z_]\w*)/g, (_, esc, p, k, offset, source) => {
  if (esc) return '$';
  let val = v[k] ?? process.env[k];
  if (p.includes('!') && val == null) throw new Error(`Variable ${k} is required`);
  if (json && val != null && isInJsonString(source, offset)) return JSON.stringify(String(val)).slice(1, -1);
  return val ?? '';
}) ?? s;

const walk = (obj, v) => {
  if (typeof obj === 'string') return sub(obj, v);
  if (Array.isArray(obj)) return obj.map(x => walk(x, v));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, walk(x, v)]));
  return obj;
};

const parseYamlApis = (content) => {
  const data = parseYaml(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data).map(([id, api]) => ({ ...parseId(id), ...api }));
};

export function getApis(configPath) {
  const path = configPath ?? resolveDefaultConfigPath();
  if (!path || !isReadableFile(path)) return [];
  const content = fs.readFileSync(path, 'utf8');
  if (path.endsWith('.txt')) {
    return parseTxt(content).apis.map(a => ({ ...parseId(`${a.service}.${a.name}`), ...a }));
  }
  return parseYamlApis(content);
}

export const getApi = (s, n, p) => getApis(p).find(a => a.service === s && a.name === n);
export const getFlow = (s, n, p) => {
  const all = getApis(p).filter(a => a.service === s);
  const base = all.find(a => a.name === n);
  const steps = all.filter(a => a.base === n && a.step != null).sort((a, b) => a.step - b.step);
  return { base, steps };
};

export function getRequest(s, n, vars = {}, p) {
  const api = getApi(s, n, p);
  if (!api) throw new Error(`Unknown API: ${s}.${n}`);
  const v = { ...vars }, provider = v.PROVIDER ?? process.env.PROVIDER;
  let { url, method, headers, body, file, multipart, output } = api;
  url = sub(url, v);
  if (typeof headers === 'string' && headers.startsWith('BEARER ')) {
    headers = { Authorization: `Bearer ${sub(headers.slice(7).trim(), v)}`, 'Content-Type': 'application/json' };
  }
  headers = walk(headers, v);
  if (body != null) {
    body = String(body).trim();
    const pb = ', "provider": {"order": ["$PROVIDER"]}';
    body = provider ? body.replace(pb, pb.replace('$PROVIDER', provider)) : body.replace(pb, '');
    body = sub(body, v, true);
  }
  file = sub(file, v);
  multipart = walk(multipart, v);
  output = sub(output, v);
  return { url, method, headers, body, file, multipart, output };
}

const getFileBody = (path) => {
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch (error) {
    throw new Error(`Unable to read upload file ${path}: ${error.message}`);
  }
};

const getMultipartBody = (fields) => {
  if (!fields || typeof fields !== 'object') return undefined;
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value && typeof value === 'object' && value.file != null) {
      const path = value.file;
      const bytes = getFileBody(path);
      const type = value.content_type || 'application/octet-stream';
      form.append(name, new Blob([bytes], { type }), value.filename || basename(path));
    } else {
      form.append(name, value == null ? '' : String(value));
    }
  }
  return form;
};

const buildWsRequest = (api, vars = {}) => {
  if (!api) throw new Error('Missing API definition');
  let { url, headers, body, keep_alive, timeout, capture } = api;
  url = sub(url, vars);
  if (typeof headers === 'string' && headers.startsWith('BEARER ')) {
    headers = { Authorization: `Bearer ${sub(headers.slice(7).trim(), vars)}` };
  }
  headers = walk(headers, vars);
  if (body != null) {
    body = String(body).trim();
    body = sub(body, vars);
  }
  capture = walk(capture, vars);
  return { url, headers, body, keep_alive, timeout, capture };
};

export function parseJsonResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const parts = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (!parts.length) return null;
    const parsed = [];
    for (const part of parts) {
      try {
        parsed.push(JSON.parse(part));
      } catch {
        throw new Error(`Failed to parse JSON. Received text: ${text}`);
      }
    }
    return parsed.length === 1 ? parsed[0] : parsed;
  }
}

export async function fetchApi(s, n, opts = {}) {
  const { vars = {}, configPath, debug, ...rest } = opts;
  const req = getRequest(s, n, { ...vars, ...rest }, configPath);
  if (debug) {
    console.error('\x1b[90m> %s %s\x1b[0m\n\x1b[90m> headers:\n%s\x1b[0m', req.method, req.url, 
      Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
    if (req.body) console.error('\x1b[90m> body: %s\x1b[0m', req.body.slice(0, 200) + (req.body.length > 200 ? '...' : ''));
  }
  const body = req.multipart ? getMultipartBody(req.multipart) : req.file ? getFileBody(req.file) : req.body || undefined;
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body });
  if (debug) {
    console.error('\n\x1b[90m< %s %s\x1b[0m', res.status, res.statusText);
    for (const [k, v] of res.headers.entries()) console.error('\x1b[90m< %s: %s\x1b[0m', k, v);
  }
  return res;
}

export async function fetchWS(s, n, opts = {}) {
  const { vars = {}, configPath, debug, onMessage } = opts;
  const { base, steps } = getFlow(s, n, configPath);
  const flow = steps.length ? steps : (base ? [base] : []);
  if (!flow.length) throw new Error(`Unknown API: ${s}.${n}`);
  const baseDefaults = steps.length ? base : null;
  const captures = {};
  const sent = new Set();
  let ws;
  let current = 0;
  let timer;
  let currentReq;

  const merge = (step) => {
    if (!baseDefaults) return step;
    return { ...baseDefaults, ...step, headers: step.headers ?? baseDefaults.headers, capture: step.capture ?? baseDefaults.capture };
  };
  const currentApi = () => merge(flow[current]);
  const canAdvance = () => {
    if (!currentReq?.keep_alive) return false;
    if (current >= flow.length - 1) return false;
    const nextRaw = flow[current + 1];
    if (nextRaw?.url != null) return false;
    const capKeys = Object.keys(currentReq.capture || {});
    return capKeys.length === 0 || capKeys.every(k => captures[k] != null);
  };

  await new Promise((resolve, reject) => {
    const finish = (err) => {
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const setTimer = (t) => {
      if (timer) clearTimeout(timer);
      if (t == null) return;
      timer = setTimeout(() => finish(new Error('WebSocket timeout')), t * 1000);
    };
    const onErr = (e) => finish(e instanceof Error ? e : new Error(String(e)));
    const onClose = () => {
      if (current < flow.length - 1) {
        const nextRaw = flow[current + 1];
        if (nextRaw?.url != null) return sendStep(current + 1, false);
      }
      finish();
    };
    const onMsg = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
      let msg;
      try { msg = JSON.parse(raw); } catch {}
      const cap = currentReq?.capture || {};
      if (msg && Object.keys(cap).length) {
        for (const [k, q] of Object.entries(cap)) captures[k] = runJq(q, JSON.stringify(msg)).trim();
      }
      if (onMessage) onMessage(msg ?? raw, { service: s, name: n, step: current, raw, send: (v) => ws.send(typeof v === 'string' ? v : JSON.stringify(v)), close: () => ws.close(), vars: { ...vars }, captures: { ...captures } });
      if (canAdvance()) sendStep(current + 1, true);
    };
    const sendStep = (idx, reuse) => {
      current = idx;
      if (sent.has(idx)) return;
      sent.add(idx);
      const v = { ...vars, ...captures };
      currentReq = buildWsRequest(currentApi(), v);
      if (!reuse) {
        const o = currentReq.headers && Object.keys(currentReq.headers).length ? { headers: currentReq.headers } : undefined;
        ws = new WebSocket(currentReq.url, o);
        ws.addEventListener('message', onMsg);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onErr);
      }
      const doSend = () => {
        if (debug) console.error('\x1b[90m> WS %s\x1b[0m', currentReq.url ?? '(reuse)');
        if (currentReq.body) ws.send(currentReq.body);
        if (canAdvance()) sendStep(current + 1, true);
      };
      if (ws.readyState === WebSocket.OPEN) doSend();
      else ws.addEventListener('open', doSend, { once: true });
      setTimer(currentReq.timeout);
    };
    try { sendStep(0, false); } catch (e) { finish(e); }
  });
}

export async function get(id, opts = {}) {
  const [s, n] = id.split('.'), res = await fetchApi(s, n, opts);
  const text = await res.text();
  const parsed = parseJsonResponse(text);
  return {
    json: (q) => q ? runJq(q, typeof parsed === 'string' ? parsed : JSON.stringify(parsed)) : parsed,
    text: () => text
  };
}
