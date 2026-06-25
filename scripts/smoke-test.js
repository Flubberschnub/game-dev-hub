const base = process.env.DEVHUB_URL || 'http://localhost:4317';

async function rpc(path, method, params = {}, token = 'dev-chat-token') {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 9999), method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

console.log('initialize chat');
console.log(await rpc('/mcp/chat', 'initialize'));

console.log('list chat tools');
const chatTools = await rpc('/mcp/chat', 'tools/list');
console.log(chatTools.tools.map((t) => t.name));

console.log('list projects');
console.log(await rpc('/mcp/chat', 'tools/call', { name: 'project_list', arguments: {} }));

console.log('create task');
console.log(
  await rpc('/mcp/chat', 'tools/call', {
    name: 'task_create',
    arguments: {
      title: 'Smoke Test Task',
      status: 'ready_for_codex',
      assignedTo: 'codex',
      designIntent: 'Verify MCP task creation works.',
      acceptanceCriteria: ['Task appears in task list'],
    },
  }),
);

console.log('initialize codex');
console.log(await rpc('/mcp/codex', 'initialize', {}, 'dev-codex-token'));

console.log('list codex tools');
const codexTools = await rpc('/mcp/codex', 'tools/list', {}, 'dev-codex-token');
console.log(codexTools.tools.map((t) => t.name));
