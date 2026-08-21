# AGENTS.md

## Repository Overview
`apicat` (`apic`) is a lightweight, zero-dependency (except `yaml`) API caller and proxy tool for Node.js (>=22) and CLI usage. It executes declarative HTTP and WebSocket API definitions defined in YAML, supporting parameter substitution, file upload/download, WebSocket flows with keep-alives/reconnect, jq filtering, and local proxying.

## Key Workflows & Agent Rules
- **Push Workflow**: When asked to push, **always** bump the patch version in `package.json`, commit, and push.
- **Running Tests**: `npm test` runs all tests via Node's native test runner (`node --test`). Keep tests fast and self-contained with no external network dependencies (use mock servers / global `fetch` mocking / local HTTP servers).

---

## Architecture & Codebase Map

```
apicat/
├── apic                  # CLI executable bin (points to ./src/apicli)
├── apicat                # CLI executable bin (points to ./src/apicli)
├── apicat.yaml           # Bundled default API definitions catalog
├── package.json          # Node module manifest (ESM, "type": "module", engines: node >= 22)
├── src/
│   ├── apicli            # Executable script that invokes runCli()
│   ├── cli.js            # CLI engine (arg parsing, commands: ls, update, proxy, <service.name>)
│   ├── fetch.js          # Core library engine: HTTP/WS client, getApis(), variable interpolation
│   ├── install.js        # Interactive first-run user config initialization (ensureUserConfig)
│   ├── proxy.js          # HTTP forward proxy implementation with Bearer token injection
│   └── yaml.js           # Lightweight YAML parse and emit utilities (wraps `yaml` package)
└── tests/
    ├── fixtures/         # Test fixtures for file and multipart uploads
    ├── proxy.test.js     # Proxy forwarding and auth tests
    ├── test.test.js      # CLI, config resolution, upload/download, and fetch tests
    └── ws.test.js        # WebSocket lifecycle, capture, heartbeat, and reconnection tests
```

---

## Configuration Resolution Hierarchy

When resolving API definitions without an explicit `--config <path>` / `configPath`:

1. **Base Configuration**:
   - Checks for `./.apicat` in current working directory (`process.cwd()`). If present, it **automatically overrides** `~/.apicat`.
   - Otherwise, checks for `~/.apicat` (`join(homedir(), '.apicat')`).
   - Fallback: Bundled `apicat.yaml` in the package root.
2. **Local YAML Additions**:
   - If `./apicat.yaml` exists in the current working directory (and is not identical to the base config file), its definitions are **added** to the base definitions. Local definitions take precedence over base definitions in case of ID collisions.
3. **Explicit Config**:
   - When `-config <path>` / `--config <path>` or `configPath` is specified, apicat loads **only** the specified file.

---

## Core Module Reference

### `src/fetch.js`
- `getApis(configPath?, options?)`: Loads and returns parsed API objects `{ id, service, name, base, step, ... }`.
- `getApi(service, name, configPath?, options?)`: Finds a single API definition.
- `getFlow(service, name, configPath?, options?)`: Retrieves base definition and ordered multi-step WebSocket flow steps (`.0`, `.1`, etc.).
- `getRequest(service, name, vars?, configPath?, options?)`: Resolves variables (`$VAR`, required `$!VAR`), builds headers, bodies, multipart payloads, or download targets.
- `fetchApi(service, name, opts)`: Executes an HTTP request and returns the `Response`.
- `fetchWS(service, name, opts)`: Manages WebSocket connections, flow progression, capture values, keep-alives, and automatic reconnection.
- `parseJsonResponse(text)`: Safely parses single or multi-line JSON responses.
- `runJq(filter, jsonText)`: Executes `jq` against JSON string.

### `src/cli.js`
- `runCli(rawArgs?, io?)`: Main CLI entrypoint. Supports dependency injection via `io` (`out`, `err`, `cwd`, `userConfigPath`, `localConfigPath`, etc.).
- Commands:
  - `apic <service.name> [KEY=val ...]`: Calls an API.
  - `apic ls [pattern]`: Lists APIs matching regex/pattern.
  - `apic update`: Downloads published YAML definitions to active user config.
  - `apic proxy -p <port> [-P backend] [-B env_var]`: Starts forward proxy.
  - `apic <service.name> --help`: Displays help for definition.

### `src/proxy.js`
- `startProxy({ port, backend, bearer, out })`: Launches forward proxy server, stripping hop-by-hop headers, rewriting host headers, and injecting bearer tokens from environment variables.
- `checkBackend(hostPort)`: Verifies connectivity to upstream proxy backend.

### `src/yaml.js`
- `parseYaml(text)` / `stringifyYaml(obj)`: YAML serialization helpers.

---

## API Definition Conventions
- **API ID format**: `<service>.<name>` (e.g. `openai.chat`, `httpbin.get`).
- **Flow steps**: `<service>.<name>.<step_number>` (e.g. `discord.gateway.0`, `discord.gateway.1`).
- **Variable syntax**:
  - `$VAR`: Optional variable (falls back to `process.env.VAR` or empty).
  - `$!VAR`: Required variable (throws if not provided in vars or environment).
  - `$$`: Escaped literal `$` character.
- **Upload / Download fields**:
  - `file`: Raw binary file upload body.
  - `multipart`: Form data fields with sub-objects specifying `file`, `content_type`, `filename`.
  - `output`: Output filepath to write response binary data.
- **WebSocket fields**:
  - `capture`: jq queries to extract values from incoming messages for subsequent steps.
  - `keep_alive`: Heartbeat configuration (`interval`, `send`, `expect`, `timeout`).
  - `reconnect`: Backoff retry policy (`enabled`, `initial`, `maximum`, `multiplier`, `jitter`).
