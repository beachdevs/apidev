# apidev

A quick and flexible API tool for calling services from the command line or as a Node.js module.

## Installation

### Quick Install

```bash
git clone https://github.com/beachdev/apidev.git
cd apidev
./install.sh
```

The installer will:
1. Create `~/.apidev/` and copy `apis.txt` there.
2. Ask to add the `api` command to your shell profile as an alias.

### Manual Installation (Alternative)

### NPM Installation

```bash
npm install apidev
```

## CLI Usage

The CLI looks for `~/.apidev/apis.txt` first, then falls back to the one in the installation directory.

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
```

## Library Usage

You can import the module to use the same logic in your own applications.

```javascript
import { fetchApi, getRequest } from 'apidev';

// Simple usage
const data = await fetchApi('httpbin', 'get', { simple: true });

// With variables and aliases (supports API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)
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
```

## Configuration (`apis.txt`)

The `apis.txt` file is a space-separated values file with a header. It supports variable substitution using `$VAR` (optional) or `!$VAR` (required).

```text
service name url method headers body
httpbin get https://httpbin.org/get GET {}
openai chat https://api.openai.com/v1/chat/completions POST "{"Authorization": "Bearer !$API_KEY"}" "{"model": "!$MODEL", "messages": [{"role": "user", "content": "!$PROMPT"}]}"
```
