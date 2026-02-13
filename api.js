#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchApi, getApi, getApis } from './fetch.js';
import { homedir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const defaultTxtPath = join(root, 'apis.txt');
const userTxtPath = join(homedir(), '.apicli', 'apis.txt');

const c = { dim: '\x1b[90m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };

const usage = `
🔌 ${c.bold}api${c.reset} ${c.dim}— call APIs (${c.cyan}./api${c.reset})${c.reset}

${c.bold}Commands${c.reset}
  ${c.cyan}list${c.reset} [pattern]          List APIs (e.g. ${c.dim}api list "openrouter*"${c.reset})
  ${c.cyan}where${c.reset}                   Show path to apis.txt
  ${c.cyan}help${c.reset} <pattern>          Show matching lines (e.g. ${c.dim}api help "h*"${c.reset})
  ${c.green}<service.name>${c.reset} [k=v …]  Call API with optional params

${c.bold}Options${c.reset}
  ${c.cyan}-time${c.reset}                   Print request duration
  ${c.cyan}-debug${c.reset}                  Print fetch request/response info (e.g. ${c.dim}api -debug httpbin.get${c.reset})

${c.bold}Note${c.reset}: Use quotes for patterns with wildcards (e.g. "h*") to prevent shell expansion.
  Private APIs in ${c.dim}~/.apicli/apis.txt${c.reset} are merged with built-ins — add your own there.

${c.bold}Example${c.reset}
  ${c.dim}api openrouter.chat API_KEY=$OPENROUTER_API_KEY MODEL=openai/gpt-4o-mini PROMPT=Hello${c.reset}
  ${c.dim}api -time httpbin.get${c.reset}
  ${c.dim}api -debug httpbin.get${c.reset}
`;

const rawArgs = process.argv.slice(2);
const timeFlag = rawArgs.includes('-time') || rawArgs.includes('--time');
const debugFlag = rawArgs.includes('-debug') || rawArgs.includes('--debug');
const args = rawArgs.filter(a => !['-time','--time','-debug','--debug'].includes(a));
const arg = args[0];
const pattern = args[1] ?? '.';

if (!arg || arg === '-h' || arg === '--help') {
  console.log(usage);
  process.exit(0);
}

if (arg === 'list') {
  const re = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
  for (const a of getApis()) {
    const id = `${a.service}.${a.name}`;
    if (re.test(id)) console.log(id);
  }
  process.exit(0);
}

if (arg === 'where') {
  console.log('default:', defaultTxtPath);
  if (fs.existsSync(userTxtPath)) console.log('user:   ', userTxtPath);
  process.exit(0);
}

if (arg === 'help') {
  const re = new RegExp(pattern.replace(/\*/g, '.*'), 'i');
  for (const f of [defaultTxtPath, userTxtPath]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (re.test(line)) console.log(line);
    }
  }
  process.exit(0);
}

if (/^\w+\.\w+$/.test(arg)) {
  const [service, name] = arg.split('.');
  const api = getApi(service, name);
  if (!api) {
    console.error('Unknown API:', arg);
    process.exit(1);
  }
  const params = {};
  for (const a of args.slice(1)) {
    const i = a.indexOf('=');
    if (i > 0) params[a.slice(0, i)] = a.slice(i + 1);
  }
  const hasBodyTemplate = api.body != null && String(api.body).trim() !== '';
  const isJsonPost = api.method === 'POST' && String(api.headers || '').includes('json');
  const overrides = hasBodyTemplate
    ? { vars: params, simple: true }
    : isJsonPost
      ? { body: JSON.stringify(params), simple: true }
      : { vars: params, simple: true };
  if (debugFlag) overrides.debug = true;
  try {
    const t0 = timeFlag ? process.hrtime.bigint() : null;
    const result = await fetchApi(service, name, overrides);
    if (t0 != null) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.error(`\x1b[90m%ims\x1b[0m`, ms.toFixed(0));
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exit(0);
}

// search apis.txt
const re2 = new RegExp(arg.replace(/\*/g, '.*'), 'i');
for (const f of [defaultTxtPath, userTxtPath]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (re2.test(line)) console.log(line);
  }
}
