import http from 'node:http';
import { JsonStore } from './storage.js';
import { UpstreamRegistry } from './upstreamMcpClient.js';
import { handleMcpRequest } from './mcpServer.js';
import { handleApiRequest, handleStaticRequest } from './httpApi.js';

const port = Number(process.env.PORT || 4317);
const dataFile = process.env.DEVHUB_DATA_FILE || './data/state.json';

const store = new JsonStore(dataFile);
store.load();
const upstreamRegistry = new UpstreamRegistry(store);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/mcp' || url.pathname === '/mcp/chat' || url.pathname === '/mcp/codex' || url.pathname === '/mcp/admin') {
    const roleFromPath = url.pathname.split('/')[2] || 'chat';
    await handleMcpRequest({ req, res, store, upstreamRegistry, roleFromPath });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApiRequest({ req, res, store, upstreamRegistry });
    if (handled) return;
  }

  handleStaticRequest(req, res);
});

server.listen(port, () => {
  console.log(`Game Dev Hub running at http://localhost:${port}`);
  console.log(`ChatGPT MCP endpoint: http://localhost:${port}/mcp/chat`);
  console.log(`Codex MCP endpoint:   http://localhost:${port}/mcp/codex`);
});
