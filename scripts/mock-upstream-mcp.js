import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;

  let result = {};
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-upstream', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'get_scene',
          description: 'Read the current scene.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'set_material',
          description: 'Assign a material.',
          inputSchema: {
            type: 'object',
            properties: { objectName: { type: 'string' } },
            required: ['objectName'],
          },
        },
        {
          name: 'delete_asset',
          description: 'Delete an asset.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'custom_action',
          description: 'A tool with no matching policy pattern.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  }

  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  if (message.method === 'tools/list') {
    lines.close();
    setTimeout(() => process.exit(0), 25);
  }
});
