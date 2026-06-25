import { spawn } from 'node:child_process';
import { summarizeObject } from './utils.js';

class JsonRpcId {
  constructor() {
    this.next = 1;
  }
  value() {
    return this.next++;
  }
}

const ids = new JsonRpcId();

export class UpstreamMcpClient {
  constructor(upstream) {
    this.upstream = upstream;
    this.initialized = false;
    this.stdioProcess = null;
    this.stdioBuffer = '';
    this.pending = new Map();
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.upstream.enabled) {
      throw new Error(`Upstream ${this.upstream.id} is disabled. Enable it in the Dev Hub UI/config.`);
    }
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'game-dev-hub',
        version: '0.1.0',
      },
    });
    try {
      await this.notify('notifications/initialized', {});
    } catch {
      // Some lightweight servers ignore notifications over simple HTTP. That is okay for MVP use.
    }
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const result = await this.request('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args = {}) {
    await this.initialize();
    return this.request('tools/call', { name, arguments: args });
  }

  async request(method, params = {}) {
    if (this.upstream.transport === 'streamable_http') {
      return this.httpRequest(method, params);
    }
    if (this.upstream.transport === 'stdio') {
      return this.stdioRequest(method, params);
    }
    throw new Error(`Unsupported upstream transport: ${this.upstream.transport}`);
  }

  async notify(method, params = {}) {
    if (this.upstream.transport === 'streamable_http') {
      const payload = { jsonrpc: '2.0', method, params };
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.upstream.headers || {}),
      };
      const response = await fetch(this.upstream.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok && response.status !== 202) {
        throw new Error(`Upstream notification failed: ${response.status} ${await response.text()}`);
      }
      return null;
    }
    if (this.upstream.transport === 'stdio') {
      const proc = this.ensureStdioProcess();
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      return null;
    }
  }

  async httpRequest(method, params = {}) {
    if (!this.upstream.url) throw new Error('HTTP upstream URL is required.');
    const payload = { jsonrpc: '2.0', id: ids.value(), method, params };
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.upstream.headers || {}),
    };
    const response = await fetch(this.upstream.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Upstream HTTP error ${response.status}: ${text}`);
    }
    return parseMcpResponse(text);
  }

  ensureStdioProcess() {
    if (this.stdioProcess) return this.stdioProcess;
    if (!this.upstream.command) throw new Error('STDIO upstream command is required.');
    const proc = spawn(this.upstream.command, this.upstream.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.upstream.env || {}) },
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.handleStdioData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      // Keep stderr visible for local debugging without leaking it to MCP callers unless a request fails.
      console.error(`[upstream:${this.upstream.id}] ${chunk}`.trim());
    });
    proc.on('exit', (code, signal) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`STDIO upstream exited: code=${code} signal=${signal}`));
      }
      this.pending.clear();
      this.stdioProcess = null;
      this.initialized = false;
    });
    this.stdioProcess = proc;
    return proc;
  }

  handleStdioData(chunk) {
    this.stdioBuffer += chunk;
    let index;
    while ((index = this.stdioBuffer.indexOf('\n')) >= 0) {
      const line = this.stdioBuffer.slice(0, index).trim();
      this.stdioBuffer = this.stdioBuffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        console.error(`Could not parse STDIO MCP line: ${line}`, error);
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || summarizeObject(msg.error)));
        else pending.resolve(msg.result);
      }
    }
  }

  stdioRequest(method, params = {}) {
    const proc = this.ensureStdioProcess();
    const requestId = ids.value();
    const payload = { jsonrpc: '2.0', id: requestId, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`STDIO upstream request timed out: ${method}`));
      }, 120_000);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
}

export class UpstreamRegistry {
  constructor(store) {
    this.store = store;
    this.clients = new Map();
  }

  getClient(projectId, upstreamId) {
    const upstream = this.store.getUpstream(projectId, upstreamId);
    if (!upstream) throw new Error(`Upstream not found: ${upstreamId}`);
    const key = `${projectId}:${upstreamId}:${JSON.stringify({
      url: upstream.url,
      command: upstream.command,
      args: upstream.args,
      env: upstream.env,
      enabled: upstream.enabled,
    })}`;
    if (!this.clients.has(key)) {
      this.clients.set(key, new UpstreamMcpClient(upstream));
    }
    return { upstream, client: this.clients.get(key) };
  }
}

function parseMcpResponse(text) {
  if (!text) return null;
  // Streamable HTTP can return plain JSON or server-sent events. Parse both enough for local use.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    if (json.error) throw new Error(json.error.message || summarizeObject(json.error));
    return json.result;
  }

  const dataLines = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line && line !== '[DONE]');
  if (dataLines.length === 0) {
    throw new Error(`Could not parse upstream MCP response: ${text.slice(0, 1000)}`);
  }
  const json = JSON.parse(dataLines.at(-1));
  if (json.error) throw new Error(json.error.message || summarizeObject(json.error));
  return json.result;
}
