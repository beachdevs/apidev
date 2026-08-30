//! apicat-mcp: High-Performance In-Memory Model Context Protocol (MCP) Server for apicat
//! Executes API calls natively in-memory with TLS connection pooling (HTTP Keep-Alive),
//! achieving sub-millisecond IPC and zero process-spawn overhead.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize, Debug)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Clone, Debug, Default)]
struct EndpointDef {
    name: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    #[allow(dead_code)]
    jq: Option<String>,
    help: String,
    required_vars: Vec<String>,
    optional_vars: Vec<String>,
}

fn parse_apicat_file(path: &PathBuf) -> HashMap<String, EndpointDef> {
    let mut map = HashMap::new();
    if !path.exists() {
        return map;
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return map,
    };

    let mut current_name: Option<String> = None;
    let mut current_block = String::new();

    for line in content.lines() {
        if line.starts_with('#') {
            continue;
        }

        // Check for top-level key: e.g. "service.name:"
        if let Some(idx) = line.find(':') {
            let key = line[..idx].trim();
            if !key.is_empty()
                && !line.starts_with(' ')
                && !line.starts_with('\t')
                && key.contains('.')
            {
                if let Some(prev) = current_name.take() {
                    parse_block(&prev, &current_block, &mut map);
                    current_block.clear();
                }
                current_name = Some(key.to_string());
                current_block.push_str(line);
                current_block.push('\n');
                continue;
            }
        }

        if current_name.is_some() {
            current_block.push_str(line);
            current_block.push('\n');
        }
    }

    if let Some(prev) = current_name {
        parse_block(&prev, &current_block, &mut map);
    }

    map
}

fn parse_block(name: &str, block: &str, map: &mut HashMap<String, EndpointDef>) {
    let mut def = EndpointDef {
        name: name.to_string(),
        method: "GET".to_string(),
        ..Default::default()
    };

    let mut in_headers = false;
    let mut in_body = false;
    let mut body_lines = Vec::new();
    let mut req_vars = HashSet::new();
    let mut opt_vars = HashSet::new();

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("url:") {
            in_headers = false;
            in_body = false;
            def.url = trimmed[4..].trim().trim_matches('"').trim_matches('\'').to_string();
        } else if trimmed.starts_with("method:") {
            in_headers = false;
            in_body = false;
            def.method = trimmed[7..].trim().to_uppercase();
        } else if trimmed.starts_with("help:") {
            in_headers = false;
            in_body = false;
            def.help = trimmed[5..].trim().trim_matches('"').trim_matches('\'').to_string();
        } else if trimmed.starts_with("headers:") {
            in_headers = true;
            in_body = false;
        } else if trimmed.starts_with("body:") {
            in_headers = false;
            in_body = true;
            let after = trimmed[5..].trim();
            if !after.is_empty() && after != "|" {
                body_lines.push(after.to_string());
            }
        } else if in_headers && (line.starts_with("  ") || line.starts_with('\t')) {
            if let Some(colon_idx) = trimmed.find(':') {
                let h_key = trimmed[..colon_idx].trim().to_string();
                let h_val = trimmed[colon_idx + 1..].trim().trim_matches('"').trim_matches('\'').to_string();
                def.headers.insert(h_key, h_val);
            }
        } else if in_body && (line.starts_with("  ") || line.starts_with('\t')) {
            body_lines.push(line.to_string());
        }
    }

    if !body_lines.is_empty() {
        def.body = Some(body_lines.join("\n"));
    }

    // Extract variables using parser
    let bytes = block.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            let is_req = bytes[i + 1] == b'!';
            let start = if is_req { i + 2 } else { i + 1 };
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_uppercase() || bytes[end].is_ascii_digit() || bytes[end] == b'_') {
                end += 1;
            }
            if end > start {
                if let Ok(var_name) = std::str::from_utf8(&bytes[start..end]) {
                    if is_req {
                        req_vars.insert(var_name.to_string());
                    } else {
                        opt_vars.insert(var_name.to_string());
                    }
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }

    def.required_vars = req_vars.into_iter().collect();
    def.optional_vars = opt_vars.into_iter().collect();
    if def.help.is_empty() {
        def.help = format!("Execute {}", name);
    }

    map.insert(name.to_string(), def);
}

fn load_all_endpoints() -> BTreeMap<String, EndpointDef> {
    let mut merged = BTreeMap::new();

    // 1. Global config: ~/.apicat
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let global_path = home.join(".apicat");
        for (k, v) in parse_apicat_file(&global_path) {
            merged.insert(k, v);
        }
    }

    // 2. Local config: ./apicat.yaml or ./.apicat
    let local_yaml = PathBuf::from("apicat.yaml");
    for (k, v) in parse_apicat_file(&local_yaml) {
        merged.insert(k, v);
    }
    let local_dot = PathBuf::from(".apicat");
    for (k, v) in parse_apicat_file(&local_dot) {
        merged.insert(k, v);
    }

    merged
}

fn interpolate(template: &str, params: &HashMap<String, String>) -> String {
    let mut res = template.to_string();

    // Replace $!VAR and $VAR
    for (k, v) in params {
        let req_pat = format!("$!{}", k);
        let opt_pat = format!("${}", k);
        res = res.replace(&req_pat, v);
        res = res.replace(&opt_pat, v);
    }

    // Check ambient environment for any remaining variables
    for (k, v) in std::env::vars() {
        let req_pat = format!("$!{}", k);
        let opt_pat = format!("${}", k);
        if res.contains(&req_pat) {
            res = res.replace(&req_pat, &v);
        }
        if res.contains(&opt_pat) {
            res = res.replace(&opt_pat, &v);
        }
    }

    res
}

fn execute_in_memory(
    agent: &ureq::Agent,
    def: &EndpointDef,
    params: &HashMap<String, String>,
) -> Result<String, String> {
    if def.url.is_empty() {
        return Err("No URL configured for endpoint".to_string());
    }

    let url = interpolate(&def.url, params);
    let method = if def.method.is_empty() { "GET" } else { &def.method };

    let mut req = agent.request(method, &url);

    // Apply headers with interpolation
    for (k, v) in &def.headers {
        let val = interpolate(v, params);
        req = req.set(k, &val);
    }

    let response = if let Some(body_str) = &def.body {
        let body_rendered = interpolate(body_str, params);
        req.send_string(&body_rendered)
    } else {
        req.call()
    };

    match response {
        Ok(resp) => {
            let body_text = resp.into_string().map_err(|e| format!("Read error: {}", e))?;
            if let Ok(parsed) = serde_json::from_str::<Value>(&body_text) {
                Ok(serde_json::to_string_pretty(&parsed).unwrap_or(body_text))
            } else {
                Ok(body_text)
            }
        }
        Err(ureq::Error::Status(code, resp)) => {
            let err_text = resp.into_string().unwrap_or_default();
            Err(format!("HTTP {} error: {}", code, err_text))
        }
        Err(ureq::Error::Transport(transport)) => Err(format!("Transport error: {}", transport)),
    }
}

fn run_apic_fallback(endpoint: &str, params: &HashMap<String, String>) -> String {
    let mut cmd = Command::new("apic");
    cmd.arg(endpoint);
    for (k, v) in params {
        if !v.trim().is_empty() {
            cmd.arg(format!("{}={}", k, v));
        }
    }

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                let stdout_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Ok(parsed) = serde_json::from_str::<Value>(&stdout_str) {
                    serde_json::to_string_pretty(&parsed).unwrap_or(stdout_str)
                } else {
                    stdout_str
                }
            } else {
                let stderr_str = String::from_utf8_lossy(&output.stderr).trim().to_string();
                json!({ "error": if stderr_str.is_empty() { format!("Exited with code {:?}", output.status.code()) } else { stderr_str } }).to_string()
            }
        }
        Err(e) => json!({ "error": format!("Fallback apic execution failed: {}", e) }).to_string(),
    }
}

fn generate_tools(endpoints: &BTreeMap<String, EndpointDef>) -> Value {
    let mut tools = Vec::new();

    let mut enum_endpoints: Vec<Value> = endpoints.keys().map(|k| json!(k)).collect();
    if enum_endpoints.is_empty() {
        enum_endpoints.push(json!("httpbin.get"));
    }

    tools.push(json!({
        "name": "apicat_call",
        "description": "Universal in-memory API caller: Execute any endpoint from ~/.apicat or ./apicat.yaml with connection pooling.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "endpoint": {
                    "type": "string",
                    "description": "Endpoint identifier (e.g. fireworks.balance, github.prComment)",
                    "enum": enum_endpoints
                },
                "params": {
                    "type": "object",
                    "description": "Parameter key-value pairs",
                    "additionalProperties": { "type": "string" }
                }
            },
            "required": ["endpoint"]
        }
    }));

    for (name, def) in endpoints {
        let tool_name = name.replace('.', "_");
        let mut props = Map::new();
        let mut req_list = Vec::new();

        for v in &def.required_vars {
            let mut prop = Map::new();
            prop.insert("type".to_string(), json!("string"));
            prop.insert("description".to_string(), json!(format!("Required parameter: {}", v)));
            props.insert(v.clone(), Value::Object(prop));

            if !v.ends_with("_KEY") && !v.ends_with("_TOKEN") {
                req_list.push(json!(v));
            }
        }

        for v in &def.optional_vars {
            let mut prop = Map::new();
            prop.insert("type".to_string(), json!("string"));
            prop.insert("description".to_string(), json!(format!("Optional parameter: {}", v)));
            props.insert(v.clone(), Value::Object(prop));
        }

        tools.push(json!({
            "name": tool_name,
            "description": def.help,
            "inputSchema": {
                "type": "object",
                "properties": props,
                "required": req_list
            }
        }));
    }

    json!(tools)
}

fn main() {
    let endpoints = load_all_endpoints();

    // Create a high-performance in-memory HTTP client with connection pooling (HTTP Keep-Alive)
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(20))
        .max_idle_connections(50)
        .max_idle_connections_per_host(10)
        .build();
    let agent = Arc::new(agent);

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                let _ = writeln!(stdout, "{}", serde_json::to_string(&err_resp).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };

        let req_id = req.id.unwrap_or(Value::Null);
        let resp: Option<Value> = match req.method.as_str() {
            "initialize" => Some(json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "apicat-rust-inmemory-mcp",
                        "version": "0.3.27"
                    }
                }
            })),
            "notifications/initialized" => None,
            "ping" => Some(json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {}
            })),
            "tools/list" => Some(json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": generate_tools(&endpoints)
                }
            })),
            "tools/call" => {
                let tool_name = req.params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = req.params.get("arguments").cloned().unwrap_or(json!({}));
                let content: String;

                let (endpoint_name, params_map) = if tool_name == "apicat_call" {
                    let ep = args.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
                    let mut p = HashMap::new();
                    if let Some(p_obj) = args.get("params").and_then(|v| v.as_object()) {
                        for (k, v) in p_obj {
                            if let Some(val_str) = v.as_str() {
                                p.insert(k.clone(), val_str.to_string());
                            }
                        }
                    }
                    (ep.to_string(), p)
                } else {
                    let dotted = tool_name.replace('_', ".");
                    let actual_ep = if endpoints.contains_key(&dotted) {
                        dotted
                    } else if let Some(found) = endpoints.keys().find(|k| k.replace('.', "_") == tool_name) {
                        found.clone()
                    } else {
                        dotted
                    };

                    let mut p = HashMap::new();
                    if let Some(args_obj) = args.as_object() {
                        for (k, v) in args_obj {
                            if let Some(val_str) = v.as_str() {
                                p.insert(k.clone(), val_str.to_string());
                            } else {
                                p.insert(k.clone(), v.to_string());
                            }
                        }
                    }
                    (actual_ep, p)
                };

                if let Some(def) = endpoints.get(&endpoint_name) {
                    // Execute in-memory with connection pooling
                    match execute_in_memory(&agent, def, &params_map) {
                        Ok(res) => content = res,
                        Err(_) => content = run_apic_fallback(&endpoint_name, &params_map),
                    }
                } else {
                    content = run_apic_fallback(&endpoint_name, &params_map);
                }

                Some(json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": content
                            }
                        ]
                    }
                }))
            }
            _ => Some(json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": { "code": -32601, "message": format!("Method not found: {}", req.method) }
            })),
        };

        if let Some(r) = resp {
            let _ = writeln!(stdout, "{}", serde_json::to_string(&r).unwrap());
            let _ = stdout.flush();
        }
    }
}
