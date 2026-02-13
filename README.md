# apicli

A quick and flexible API tool for calling services from the command line or as a Node.js module.

## Installation

```bash
git clone https://github.com/beachdevs/apicli.git && cd apicli && ./install.sh
```

This creates `~/.apicli/` for your custom APIs and adds the `api` alias to your shell. Run `git pull` to get updates.

## CLI Usage

Built-in APIs are loaded from the repo's `apis.txt`. Private APIs in `~/.apicli/apis.txt` are merged on top — entries with the same `service.name` override the defaults. Add your own APIs there.

**Options:** `-time` — print request duration; `-debug` — print fetch request/response info (URL, headers, status) to stderr.

```bash
# List all available APIs
api list

# Filter APIs
api list httpbin

# Show the location of the apis.txt file being used
api where

# Show matching lines from apis.txt
api help httpbin

# Call an API
api httpbin.get

# Call an API with parameters
api httpbin.get foo=bar

# Call an API requiring keys
api openai.chat API_KEY=$OPENAI_API_KEY MODEL=gpt-4o-mini PROMPT="Hello!"

# OpenRouter with optional provider
api openrouter.chat API_KEY=$OPENROUTER_API_KEY MODEL=openai/gpt-4o-mini PROVIDER=openai PROMPT="Hello!"

# Cerebras (API_KEY or CEREBRAS_API_KEY)
api cerebras.chat API_KEY=$CEREBRAS_API_KEY MODEL=llama3.1-8b PROMPT="Hello!"

# Time the request
api -time httpbin.get

# Debug: show request/response info
api -debug httpbin.get
```

## Library Usage

You can import the module to use the same logic in your own applications.

```javascript
import { fetchApi, getRequest } from 'apicli';

// Simple usage
const data = await fetchApi('httpbin', 'get', { simple: true });

// With variables and aliases (API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, CEREBRAS_API_KEY)
const res = await fetchApi('openai', 'chat', {
  vars: {
    API_KEY: 'your-key',
    MODEL: 'gpt-4o',
    PROMPT: 'Hello world'
  }
});

// Using a custom local apis.txt file
const customData = await fetchApi('my-service', 'my-name', {
  configPath: './local-apis.txt',
  simple: true
});

// With debug: logs request/response info to stderr
const data = await fetchApi('httpbin', 'get', { simple: true, debug: true });
```

## Configuration (`apis.txt`)

The `apis.txt` file is a space-separated values file with a header. It supports variable substitution using `$VAR` (optional) or `!$VAR` (required).

```text
service name url method headers body
httpbin get https://httpbin.org/get GET {}
openai chat https://api.openai.com/v1/chat/completions POST "{"Authorization": "Bearer !$API_KEY"}" "{"model": "!$MODEL", "messages": [{"role": "user", "content": "!$PROMPT"}]}"
```

OpenRouter supports optional `$PROVIDER` to prefer a specific provider (e.g. `order: ["openai"]`).
