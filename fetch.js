import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_TXT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'apis.txt');

const parse = (c) => {
  const lines = c.trim().split('\n');
  const h = lines[0].trim().split(/\s+/).filter(Boolean);
  const rows = lines.slice(1).map(l => {
    const v = []; let cur = '', q = 0;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && l[i+1] === '"') { cur += '"'; i++; }
      else if (l[i] === '"') q = !q;
      else if (l[i] === ' ' && !q) { v.push(cur); cur = ''; }
      else cur += l[i];
    }
    return [...v, cur];
  });
  return { apis: rows.map(r => Object.fromEntries(h.map((k, i) => {
    let v = r[i] === 'null' ? null : r[i];
    if (k !== 'body' && v != null) {
      try { if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) v = JSON.parse(v); } catch(e){}
    }
    return [k, v];
  }))) };
};

const VAR_ALIASES = { 
  API_KEY: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'],
  OPENAI_API_KEY: ['API_KEY'],
  OPENROUTER_API_KEY: ['API_KEY']
};
const sub = (s, v = {}) => s?.replace?.(/(!?)\$([A-Za-z_]\w*)/g, (_, r, k) => {
  let val = v[k] ?? process.env[k];
  if (val == null && VAR_ALIASES[k]) {
    for (const alt of VAR_ALIASES[k]) {
      val = v[alt] ?? process.env[alt];
      if (val != null) break;
    }
  }
  if (r && val == null) throw new Error(`Variable ${k} is required`);
  return val ?? '';
}) ?? s;

const walk = (obj, v) => {
  if (typeof obj === 'string') return sub(obj, v);
  if (Array.isArray(obj)) return obj.map(x => walk(x, v));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, walk(x, v)]));
  return obj;
};

export function getApis(configPath = DEFAULT_TXT_PATH) {
  return parse(fs.readFileSync(configPath, 'utf8')).apis;
}

export function getApi(service, name, configPath) {
  return getApis(configPath).find(a => a.service === service && a.name === name);
}

export function getRequest(service, name, vars = {}, configPath) {
  const api = getApi(service, name, configPath);
  if (!api) throw new Error(`Unknown API: ${service}/${name}`);
  const url = sub(api.url, vars);
  const headers = walk(api.headers, vars);
  const body = api.body != null ? sub(String(api.body).trim(), vars) : undefined;
  return { url, method: api.method, headers, body };
}

export async function fetchApi(service, name, overrides = {}) {
  const opts = overrides === 'simple' ? { simple: true } : overrides;
  const { vars = {}, simple, configPath, ...rest } = opts;
  const { url, method, headers, body } = getRequest(service, name, { ...vars, ...rest }, configPath);
  const res = await fetch(url, { method, headers, body: body || undefined });
  return simple ? res.json() : res;
}
