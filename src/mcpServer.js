import { callDevHubTool, chatFullAccessForActiveUpstream, listDevHubTools } from './tools.js';
import { getBearerToken, readRequestBody, respondJson } from './utils.js';

const SERVER_INFO = {
  name: 'game-dev-hub',
  version: '0.1.0',
};

const PROTOCOL_VERSION = '2025-06-18';

export async function handleMcpRequest({ req, res, store, upstreamRegistry, roleFromPath }) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    respondJson(res, 405, { error: 'MCP endpoint expects POST requests.' }, corsHeaders());
    return;
  }

  let role;
  try {
    role = authenticate(req, roleFromPath);
  } catch (error) {
    respondJson(res, 401, { error: error.message }, corsHeaders());
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch (error) {
    respondJson(res, 400, jsonRpcError(null, -32700, `Parse error: ${error.message}`), corsHeaders());
    return;
  }

  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const message of requests) {
    const response = await handleJsonRpcMessage({ message, store, upstreamRegistry, role });
    if (response) responses.push(response);
  }

  if (responses.length === 0) {
    res.writeHead(202, corsHeaders());
    res.end();
    return;
  }

  respondJson(res, 200, Array.isArray(body) ? responses : responses[0], corsHeaders());
}

async function handleJsonRpcMessage({ message, store, upstreamRegistry, role }) {
  if (!message || message.jsonrpc !== '2.0' || !message.method) {
    return jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }

  const isNotification = message.id === undefined || message.id === null;
  try {
    const result = await dispatch({ method: message.method, params: message.params || {}, store, upstreamRegistry, role });
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: message.id, result };
  } catch (error) {
    if (isNotification) return null;
    return jsonRpcError(message.id, -32000, error.message || 'Tool call failed.');
  }
}

async function dispatch({ method, params, store, upstreamRegistry, role }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions:
          role === 'chat'
            ? chatFullAccessForActiveUpstream(store)
              ? 'You are connected to Game Dev Hub as ChatGPT. Use project docs/tasks/messages for planning and review. Unity access has explicit full access enabled for the active upstream; respect Dev Hub tool categories and explicit deny overrides.'
              : 'You are connected to Game Dev Hub as ChatGPT. Use project docs/tasks/messages for planning and review. Unity access is read-only through policy-filtered tools.'
            : role === 'codex'
              ? 'You are connected to Game Dev Hub as Codex. Use project docs/tasks/messages for implementation handoffs. Unity access is policy-controlled through unity_call_tool.'
              : 'You are connected to Game Dev Hub as admin.',
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: listDevHubTools(role, { chatFullAccess: role === 'chat' && chatFullAccessForActiveUpstream(store) }) };

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      if (!name) throw new Error('tools/call requires params.name.');
      return callDevHubTool({ store, upstreamRegistry, role, name, args });
    }

    case 'resources/list':
      return { resources: [] };

    case 'resources/read':
      throw new Error('Resources are not implemented in this MVP. Use docs_read instead.');

    case 'prompts/list':
      return { prompts: [] };

    case 'notifications/initialized':
      return {};

    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

function authenticate(req, roleFromPath) {
  const chatToken = process.env.DEVHUB_CHAT_TOKEN || 'dev-chat-token';
  const codexToken = process.env.DEVHUB_CODEX_TOKEN || 'dev-codex-token';
  const adminToken = process.env.DEVHUB_ADMIN_TOKEN || 'dev-admin-token';
  const token = getBearerToken(req);

  // Local dev convenience: when explicit role paths are used and no custom env tokens are set,
  // allow missing auth. Set any DEVHUB_*_TOKEN value to require auth.
  const customTokensSet = Boolean(process.env.DEVHUB_CHAT_TOKEN || process.env.DEVHUB_CODEX_TOKEN || process.env.DEVHUB_ADMIN_TOKEN);
  if (!token && !customTokensSet && ['chat', 'codex', 'admin'].includes(roleFromPath)) {
    return roleFromPath;
  }

  if (token === chatToken) return 'chat';
  if (token === codexToken) return 'codex';
  if (token === adminToken) return 'admin';

  throw new Error('Missing or invalid bearer token.');
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}
