# apicat-mcp: High-Performance Rust MCP Server

A native Model Context Protocol (MCP) server for `apicat`, allowing AI coding assistants (Antigravity, Claude Desktop, Claude Code, Cursor, Windsurf, Cline) to discover and execute API definitions with zero token-reading overhead.

---

## ⚡ Features
* **Sub-5ms Cold Start**: Instant stdio JSON-RPC initialization.
* **<2MB Memory (RSS)**: Ultra-lightweight background execution.
* **Auto-Discovery**: Automatically loads and merges endpoints from `~/.apicat` and `./apicat.yaml`.
* **Typed Schemas**: Extracts `$!REQUIRED` and `$OPTIONAL` parameters into JSON Schema tool definitions.

---

## 🔨 How to Compile

### Prerequisites
* Rust 1.75+ / `cargo`

### Build Release Binary
From the `apicat` root directory:
```bash
cargo build --release --manifest-path mcp/Cargo.toml
```

The compiled binary will be located at:
```bash
mcp/target/release/apicat-mcp
```

---

## 🤖 Agent Configuration

### 1. Antigravity / Gemini CLI (`~/.gemini/config/mcp_config.json`)
```json
{
  "mcpServers": {
    "apicat": {
      "command": "/Users/chris/apicat/mcp/target/release/apicat-mcp"
    }
  }
}
```

### 2. Claude Desktop (`claude_desktop_config.json`) / Claude Code
```json
{
  "mcpServers": {
    "apicat": {
      "command": "/absolute/path/to/apicat/mcp/target/release/apicat-mcp"
    }
  }
}
```

### 3. Cursor IDE (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "apicat": {
      "command": "/absolute/path/to/apicat/mcp/target/release/apicat-mcp"
    }
  }
}
```
