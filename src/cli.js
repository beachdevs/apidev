import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fetchApi, fetchWS, getApi, getApis, getFlow, getRequest, parseJsonResponse, runJq } from './fetch.js';
import { ensureUserConfig, defaultUserConfigPath, defaultBundledConfigPath } from './install.js';
import { startProxy, checkBackend } from './proxy.js';
import { parseYaml } from './yaml.js';

const publishedConfigUrl = 'https://raw.githubusercontent.com/beachdevs/apicat/refs/heads/master/apicat.yaml';
const c = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const usage = `
🔌 ${c.bold}apicat${c.reset} ${c.dim}v${version} — call APIs (${c.cyan}apic${c.reset})${c.reset}

${c.bold}Commands${c.reset}
  ${c.green}apic <service.name>${c.reset} [k=v …]  Call API with optional params
  ${c.cyan}apic ls|list${c.reset} [pattern]       List APIs
  ${c.cyan}apic update${c.reset}                  Copy latest published ${c.dim}.apicat${c.reset} to ${c.dim}~/.apicat${c.reset}
  ${c.cyan}apic <service.name> --help${c.reset}   Show help for this api call
  ${c.cyan}apic proxy -p <port>${c.reset} [${c.dim}-P <backend host:port>${c.reset}]
                       Forward HTTP requests; -P pins the backend target

${c.bold}Options${c.reset}
  ${c.cyan}apic <service.name> --time${c.reset}          Show request duration
  ${c.cyan}apic <service.name> --debug${c.reset}         Show fetch request/response info
  ${c.cyan}apic --config <path> httpbin.get${c.reset}    Use custom config file instead of ${c.dim}~/.apicat${c.reset}
`;

export const formatResponse = (text, jq) => jq ? runJq(jq, text).trimEnd() : JSON.stringify(parseJsonResponse(text), null, 2);

export const parseArgs = (raw = []) => {
  const flags = ['-time', '--time', '-debug', '--debug', '-h', '--help', '-p', '-P'];
  const configIdx = raw.findIndex(a => a === '-config' || a === '--config');
  const portIdx = raw.indexOf('-p');
  const backendIdx = raw.indexOf('-P');
  if (configIdx >= 0 && (!raw[configIdx + 1] || raw[configIdx + 1].startsWith('-'))) return { error: 'Error: -config requires a file path' };
  if (portIdx >= 0 && (!raw[portIdx + 1] || raw[portIdx + 1].startsWith('-'))) return { error: 'Error: -p requires a port' };
  if (backendIdx >= 0 && (!raw[backendIdx + 1] || raw[backendIdx + 1].startsWith('-'))) return { error: 'Error: -P requires a backend host:port' };
  const skip = new Set();
  for (const i of [configIdx, portIdx, backendIdx]) if (i >= 0) skip.add(i).add(i + 1);
  const args = raw.filter((a, i) => !flags.includes(a) && !skip.has(i));
  return { args, arg: args[0], pattern: args[1] ?? '.', time: raw.includes('-time') || raw.includes('--time'), debug: raw.includes('-debug') || raw.includes('--debug'), help: raw.includes('-h') || raw.includes('--help'), configPath: configIdx >= 0 ? raw[configIdx + 1] : null, port: portIdx >= 0 ? raw[portIdx + 1] : null, proxyBackend: backendIdx >= 0 ? raw[backendIdx + 1] : null };
};

export async function runCli(raw = process.argv.slice(2), io = {}) {
  const out = io.out ?? console.log, err = io.err ?? console.error;
  const userConfigPath = io.userConfigPath ?? defaultUserConfigPath;
  const bundledConfigPath = io.bundledConfigPath ?? defaultBundledConfigPath;
  const hasUser = () => fs.existsSync(userConfigPath);
  const cfg = (p) => p ?? (hasUser() ? userConfigPath : (fs.existsSync(bundledConfigPath) ? bundledConfigPath : null));
  const { error, args, arg, pattern, time, debug, help, configPath, port, proxyBackend } = parseArgs(raw);
  const re = (s) => new RegExp(s.replace(/\*/g, '.*'), 'i');
  const printConfig = () => { const p = cfg(configPath); if (p) err(configPath ? 'config:' : hasUser() ? 'user:   ' : 'bundled:', p); };
  const search = (rx) => { const p = cfg(configPath); if (p && fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (rx.test(l)) out(l); };
  const update = async () => {
    if (hasUser()) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(`Refusing to overwrite ${userConfigPath} without confirmation. Run \`apic update\` in an interactive terminal.`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`This will overwrite ${userConfigPath}. Are you sure? [y/N] `)).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          out('Update cancelled.');
          return false;
        }
      } finally {
        rl.close();
      }
    }
    const r = await fetch(publishedConfigUrl);
    if (!r.ok) throw new Error(`Failed to download ${publishedConfigUrl}: ${r.status} ${r.statusText}`);
    const text = await r.text();
    parseYaml(text);
    fs.writeFileSync(userConfigPath, text, 'utf8');
    out(userConfigPath);
    return true;
  };

  if (error) return err(error), 1;
  if (arg === 'proxy') {
    try {
      if (proxyBackend && !(await checkBackend(proxyBackend))) {
        err(`Error: cannot reach proxy backend ${proxyBackend}`);
        return 1;
      }
      startProxy({ port: Number(port) || 8080, backend: proxyBackend, out });
      return 0;
    } catch (e) {
      err(e.message);
      return 1;
    }
  }
  await ensureUserConfig({ arg, configPath, userConfigPath, bundledConfigPath });
  if (!args.length) printConfig();
  if (!arg) return out(usage), 0;
  if (arg === 'ls' || arg === 'list') {
    out('');
    for (const a of getApis(cfg(configPath)).sort((a, b) => (a.id ?? `${a.service}.${a.name}`).localeCompare(b.id ?? `${b.service}.${b.name}`))) {
      const id = a.id ?? `${a.service}.${a.name}`;
      if (re(pattern).test(id)) out(`${c.cyan}${id}${c.reset}`);
    }
    out('');
    return 0;
  }
  if (arg === 'help') return search(re(pattern)), 0;
  if (arg === 'update') {
    try { await update(); return 0; } catch (e) { err(e.message); return 1; }
  }
  if (!/^\w+\.\w+$/.test(arg)) return search(re(arg)), 0;

  const p = cfg(configPath), [service, name] = arg.split('.'), params = Object.fromEntries(args.slice(1).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]).filter(([k]) => k));
  const { base, steps } = getFlow(service, name, p), api = base ?? getApi(service, name, p);
  if (!api && !steps.length) return err('Unknown API:', arg), 1;
  if (help) return out(base?.help ?? api?.help ?? steps[0]?.help ?? 'No help available.'), 0;
  const isWs = steps.length || String(api?.url ?? '').startsWith('ws');
  const hasBody = api?.body != null && String(api.body).trim() !== '';
  const hasUpload = api?.file != null || api?.multipart != null;
  const jsonPost = api?.method === 'POST' && (typeof api.headers === 'string' ? /json|^bearer /i.test(api.headers) : Object.entries(api?.headers || {}).some(([k, v]) => k.toLowerCase() === 'content-type' && String(v).toLowerCase().includes('json')));
  const opts = isWs || hasBody || hasUpload ? { vars: params, configPath: p } : jsonPost ? { body: JSON.stringify(params), configPath: p } : { vars: params, configPath: p };
  if (debug) opts.debug = true;
  try {
    const t0 = time ? process.hrtime.bigint() : null;
    let elapsed;
    if (isWs) {
      await fetchWS(service, name, { ...opts, onMessage: (_msg, ctx) => out(ctx.raw) });
      if (t0) elapsed = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0);
    } else {
      const response = await fetchApi(service, name, opts);
      if (t0) elapsed = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0);
      const { output } = getRequest(service, name, params, p);
      if (output && response.ok) {
        fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
        out(output);
      } else {
        const text = await response.text();
        out(formatResponse(text, api?.jq));
      }
    }
    if (elapsed) err(`\x1b[90m%ims\x1b[0m`, elapsed);
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
