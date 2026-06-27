import { isAllowed } from './policy.js';
import { detectToolProfile } from './toolProfiles.js';
import { requireFields, summarizeObject } from './utils.js';

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { value },
  };
}

function schema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function mcpTool(definition, { category = 'read', outputSchema = null } = {}) {
  return {
    ...definition,
    annotations: safetyAnnotations(category),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

function safetyAnnotations(category) {
  if (category === 'destructive') {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
  }

  if (category === 'write') {
    return {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    };
  }

  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

const categoryProperty = {
  type: 'string',
  enum: ['read', 'write', 'destructive', 'deny', 'unknown'],
};

const upstreamCatalogOutputSchema = schema({
  upstream: { type: 'object', additionalProperties: true },
  tools: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        inputSchema: { type: 'object', additionalProperties: true },
        devHubCategory: categoryProperty,
        devHubAllowedForCaller: { type: 'boolean' },
        devHubSafety: {
          type: 'object',
          properties: {
            readOnlyHint: { type: 'boolean' },
            destructiveHint: { type: 'boolean' },
            idempotentHint: { type: 'boolean' },
            openWorldHint: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['name', 'devHubCategory', 'devHubAllowedForCaller', 'devHubSafety'],
      additionalProperties: true,
    },
  },
}, ['upstream', 'tools']);

const upstreamToolCallOutputSchema = schema({
  upstream: { type: 'object', additionalProperties: true },
  toolName: { type: 'string' },
  category: categoryProperty,
  safety: {
    type: 'object',
    properties: {
      readOnlyHint: { type: 'boolean' },
      destructiveHint: { type: 'boolean' },
      idempotentHint: { type: 'boolean' },
      openWorldHint: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  result: { type: 'object', additionalProperties: true },
}, ['upstream', 'toolName', 'category', 'safety', 'result']);

function projectIdFrom(store, args) {
  return args?.projectId || store.getActiveProject()?.id;
}

export function listDevHubTools(role, options = {}) {
  const chatFullAccess = Boolean(options.chatFullAccess);
  const common = [
    {
      name: 'hub_help',
      description: 'Explain the Game Dev Hub workflow, roles, and available tool categories.',
      inputSchema: schema(),
    },
    {
      name: 'project_list',
      description: 'List all configured game projects in the Dev Hub.',
      inputSchema: schema(),
    },
    {
      name: 'project_get',
      description: 'Read project metadata. Defaults to the active project when projectId is omitted.',
      inputSchema: schema({ projectId: { type: 'string' } }),
    },
    {
      name: 'project_set_active',
      description: 'Set the active project for future calls that omit projectId.',
      inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']),
    },
    {
      name: 'project_create',
      description: 'Create a game project with its own configuration and starter documents.',
      inputSchema: schema(
        {
          name: { type: 'string' },
          repoPath: { type: 'string' },
          unityProjectPath: { type: 'string' },
          docsPath: { type: 'string' },
          obsidianVaultPath: { type: 'string' },
        },
        ['name'],
      ),
    },
    {
      name: 'project_update',
      description: 'Update a project name, paths, or active upstream configuration.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          name: { type: 'string' },
          repoPath: { type: 'string' },
          unityProjectPath: { type: 'string' },
          docsPath: { type: 'string' },
          obsidianVaultPath: { type: 'string' },
          activeUpstreamId: { type: 'string' },
        },
        ['projectId'],
      ),
    },
    {
      name: 'docs_list',
      description: 'List project documents such as AGENTS.md, GAME_DESIGN.md, and task notes.',
      inputSchema: schema({ projectId: { type: 'string' } }),
    },
    {
      name: 'docs_read',
      description: 'Read a project document by path or document id.',
      inputSchema: schema({ projectId: { type: 'string' }, pathOrId: { type: 'string' } }, ['pathOrId']),
    },
    {
      name: 'docs_search',
      description: 'Search project documents by keyword.',
      inputSchema: schema({ projectId: { type: 'string' }, query: { type: 'string' } }, ['query']),
    },
    {
      name: 'docs_write',
      description: 'Create or replace a project document. Use append=true to append instead of replacing.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string' },
          content: { type: 'string' },
          append: { type: 'boolean' },
        },
        ['path', 'content'],
      ),
    },
    {
      name: 'vault_list',
      description: 'List Markdown notes in the project-configured Obsidian vault. This is separate from Dev Hub project documents.',
      inputSchema: schema({ projectId: { type: 'string' } }),
    },
    {
      name: 'vault_read',
      description: 'Read a Markdown note from the project-configured Obsidian vault by vault-relative path.',
      inputSchema: schema({ projectId: { type: 'string' }, path: { type: 'string' } }, ['path']),
    },
    {
      name: 'vault_search',
      description: 'Search Markdown notes in the project-configured Obsidian vault by keyword.',
      inputSchema: schema({ projectId: { type: 'string' }, query: { type: 'string' } }, ['query']),
    },
    {
      name: 'vault_write',
      description: 'Create or replace a Markdown note in the project-configured Obsidian vault. Use append=true to append instead of replacing.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
          append: { type: 'boolean' },
        },
        ['path', 'content'],
      ),
    },
    {
      name: 'tasks_list',
      description: 'List active tasks for a project, optionally filtered by status. Set archivedOnly or includeArchived to inspect archived work.',
      inputSchema: schema({
        projectId: { type: 'string' },
        status: { type: 'string' },
        includeArchived: { type: 'boolean' },
        archivedOnly: { type: 'boolean' },
      }),
    },
    {
      name: 'task_read',
      description: 'Read a task by id.',
      inputSchema: schema({ projectId: { type: 'string' }, taskId: { type: 'string' } }, ['taskId']),
    },
    {
      name: 'task_create',
      description: 'Create a project task or handoff packet for ChatGPT, Codex, or the human developer.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          title: { type: 'string' },
          parentTaskId: { type: 'string' },
          status: { type: 'string' },
          designIntent: { type: 'string' },
          implementationNotes: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          assignedTo: { type: 'string' },
          createdBy: { type: 'string' },
        },
        ['title'],
      ),
    },
    {
      name: 'task_update',
      description: 'Update a project task status, notes, assignee, or acceptance criteria.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          title: { type: 'string' },
          parentTaskId: { type: 'string' },
          status: { type: 'string' },
          designIntent: { type: 'string' },
          implementationNotes: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          assignedTo: { type: 'string' },
          reviewNote: { type: 'string' },
          requestChanges: { type: 'boolean' },
          archive: { type: 'boolean' },
          updatedBy: { type: 'string' },
          completedBy: { type: 'string' },
          changesRequestedBy: { type: 'string' },
        },
        ['taskId'],
      ),
    },
    {
      name: 'task_delete',
      description: 'Permanently delete a task. Subtasks are moved to the deleted task parent.',
      inputSchema: schema({ projectId: { type: 'string' }, taskId: { type: 'string' } }, ['taskId']),
    },
    {
      name: 'messages_list',
      description: 'List agent/human messages for a project or task.',
      inputSchema: schema({ projectId: { type: 'string' }, taskId: { type: 'string' } }),
    },
    {
      name: 'message_post',
      description: 'Post a message from ChatGPT, Codex, or the human into project memory.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          from: { type: 'string' },
          content: { type: 'string' },
        },
        ['content'],
      ),
    },
    {
      name: 'decisions_list',
      description: 'List recorded architectural/design decisions for a project.',
      inputSchema: schema({ projectId: { type: 'string' } }),
    },
    {
      name: 'decision_record',
      description: 'Record a durable design or architecture decision.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          title: { type: 'string' },
          rationale: { type: 'string' },
          consequences: { type: 'string' },
          createdBy: { type: 'string' },
        },
        ['title'],
      ),
    },
    {
      name: 'upstreams_list',
      description: 'List configured upstream Unity MCP servers for a project.',
      inputSchema: schema({ projectId: { type: 'string' } }),
    },
    {
      name: 'upstream_tool_catalog',
      description: 'List tools exposed by an upstream Unity MCP server. This calls the upstream tools/list method.',
      inputSchema: schema({ projectId: { type: 'string' }, upstreamId: { type: 'string' } }, ['upstreamId']),
    },
    {
      name: 'audit_list',
      description: 'List recent Dev Hub tool audit entries.',
      inputSchema: schema({ projectId: { type: 'string' }, limit: { type: 'number' } }),
    },
  ];

  const chatTools = [
    {
      name: 'unity_call_read_tool',
      description: chatFullAccess
        ? 'Call a tool on the configured upstream Unity MCP. ChatGPT full access is enabled for the active upstream, so write and destructive-classified tools may be called unless explicitly denied.'
        : 'Call a read-classified tool on the configured upstream Unity MCP. Only available to ChatGPT/read roles.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          upstreamId: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object' },
        },
        ['upstreamId', 'toolName'],
      ),
    },
    {
      name: 'unity_scene_overview',
      description: 'Call the upstream semantic scene overview tool, if configured for the active Unity MCP.',
      inputSchema: schema({ projectId: { type: 'string' }, upstreamId: { type: 'string' }, arguments: { type: 'object' } }, ['upstreamId']),
    },
    {
      name: 'unity_console_read',
      description: 'Call the upstream semantic console/log read tool, if configured for the active Unity MCP.',
      inputSchema: schema({ projectId: { type: 'string' }, upstreamId: { type: 'string' }, arguments: { type: 'object' } }, ['upstreamId']),
    },
    {
      name: 'unity_screenshot',
      description: 'Call the upstream semantic screenshot tool, if configured for the active Unity MCP.',
      inputSchema: schema({ projectId: { type: 'string' }, upstreamId: { type: 'string' }, arguments: { type: 'object' } }, ['upstreamId']),
    },
  ];

  const codexTools = [
    {
      name: 'unity_call_tool',
      description: 'Call an allowed upstream Unity MCP tool through Dev Hub policy. Destructive tools may require confirm=true.',
      inputSchema: schema(
        {
          projectId: { type: 'string' },
          upstreamId: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object' },
          confirm: { type: 'boolean' },
        },
        ['upstreamId', 'toolName'],
      ),
    },
  ];

  const decorateTools = (tools) => tools.map((tool) => mcpTool(tool, {
    category: toolSafetyCategory(tool.name, { chatFullAccess }),
    outputSchema: toolOutputSchema(tool.name),
  }));

  if (role === 'chat') return decorateTools([...common, ...chatTools]);
  if (role === 'codex') return decorateTools([...common, ...codexTools]);
  if (role === 'admin') return decorateTools([...common, ...chatTools, ...codexTools]);
  return decorateTools(common);
}

function toolSafetyCategory(toolName, { chatFullAccess = false } = {}) {
  if ([
    'project_set_active',
    'project_create',
    'project_update',
    'docs_write',
    'vault_write',
    'task_create',
    'task_update',
    'message_post',
    'decision_record',
  ].includes(toolName)) {
    return 'write';
  }

  if (['task_delete', 'unity_call_tool'].includes(toolName)) {
    return 'destructive';
  }

  if (toolName === 'unity_call_read_tool' && chatFullAccess) {
    return 'destructive';
  }

  return 'read';
}

function toolOutputSchema(toolName) {
  if (toolName === 'upstream_tool_catalog') return upstreamCatalogOutputSchema;
  if ([
    'unity_call_read_tool',
    'unity_scene_overview',
    'unity_console_read',
    'unity_screenshot',
    'unity_call_tool',
  ].includes(toolName)) {
    return upstreamToolCallOutputSchema;
  }
  return null;
}

export function chatFullAccessForActiveUpstream(store) {
  const project = store.getActiveProject();
  if (!project?.activeUpstreamId) return false;
  return chatFullAccessForUpstream(store, project.id, project.activeUpstreamId);
}

function chatFullAccessForUpstream(store, projectId, upstreamId) {
  if (!projectId || !upstreamId) return false;
  const upstream = store.getUpstream(projectId, upstreamId);
  return Boolean(upstream?.policy?.chatFullAccess);
}

export async function callDevHubTool({ store, upstreamRegistry, role, name, args = {} }) {
  const projectId = projectIdFrom(store, args);
  if (!projectId && !['project_list', 'project_create', 'hub_help'].includes(name)) {
    throw new Error('No active project found.');
  }

  switch (name) {
    case 'hub_help':
      return textResult({
        purpose: 'Game Dev Hub coordinates ChatGPT and Codex through project docs, task handoffs, messages, decisions, and policy-controlled Unity MCP access.',
        roles: {
          chat: 'Planning/review plus read-only Unity inspection.',
          codex: 'Implementation plus policy-controlled Unity MCP passthrough.',
        },
        suggestedFlow: [
          'ChatGPT reads docs and creates a READY_FOR_CODEX task.',
          'Codex reads the task, implements changes, runs Unity checks through MCP, and posts a result note.',
          'ChatGPT reviews the result and creates follow-up tasks or records acceptance.',
        ],
      });

    case 'project_list':
      return textResult({ activeProjectId: store.getState().activeProjectId, projects: store.listProjects() });

    case 'project_get':
      return textResult(store.getProject(projectId));

    case 'project_set_active':
      requireFields(args, ['projectId']);
      return textResult(store.setActiveProject(args.projectId));

    case 'project_create':
      requireFields(args, ['name']);
      return textResult(store.createProject(args));

    case 'project_update':
      requireFields(args, ['projectId']);
      return textResult(store.updateProject(args.projectId, args));

    case 'docs_list':
      return textResult(store.listDocuments(projectId).map(({ content, ...doc }) => ({ ...doc, contentLength: content.length })));

    case 'docs_read':
      requireFields(args, ['pathOrId']);
      return textResult(store.getDocument(projectId, args.pathOrId));

    case 'docs_search':
      requireFields(args, ['query']);
      return textResult(store.searchDocuments(projectId, args.query));

    case 'docs_write':
      requireFields(args, ['path', 'content']);
      return textResult(
        store.writeDocument(projectId, {
          path: args.path,
          title: args.title,
          kind: args.kind,
          content: args.content,
          append: Boolean(args.append),
        }),
      );

    case 'vault_list':
      return textResult(store.listVaultNotes(projectId));

    case 'vault_read':
      requireFields(args, ['path']);
      return textResult(store.getVaultNote(projectId, args.path));

    case 'vault_search':
      requireFields(args, ['query']);
      return textResult(store.searchVaultNotes(projectId, args.query));

    case 'vault_write':
      requireFields(args, ['path', 'content']);
      return textResult(
        store.writeVaultNote(projectId, {
          path: args.path,
          content: args.content,
          append: Boolean(args.append),
        }),
      );

    case 'tasks_list':
      return textResult(store.listTasks(projectId, {
        status: args.status,
        includeArchived: Boolean(args.includeArchived),
        archivedOnly: Boolean(args.archivedOnly),
      }));

    case 'task_read':
      requireFields(args, ['taskId']);
      return textResult(store.getTask(projectId, args.taskId));

    case 'task_create':
      return textResult(store.createTask(projectId, { ...args, createdBy: args.createdBy || role }));

    case 'task_update':
      requireFields(args, ['taskId']);
      return textResult(store.updateTask(projectId, args.taskId, args));

    case 'task_delete':
      requireFields(args, ['taskId']);
      return textResult(store.deleteTask(projectId, args.taskId));

    case 'messages_list':
      return textResult(store.listMessages(projectId, args.taskId));

    case 'message_post':
      requireFields(args, ['content']);
      return textResult(store.postMessage(projectId, { ...args, from: args.from || role }));

    case 'decisions_list':
      return textResult(store.listDecisions(projectId));

    case 'decision_record':
      requireFields(args, ['title']);
      return textResult(store.recordDecision(projectId, { ...args, createdBy: args.createdBy || role }));

    case 'upstreams_list':
      return textResult(store.listUpstreams(projectId));

    case 'upstream_tool_catalog':
      return callUpstreamCatalog({ store, upstreamRegistry, role, projectId, args });

    case 'unity_call_read_tool':
      if (role !== 'chat' && role !== 'admin') throw new Error('unity_call_read_tool is only available to chat/admin roles.');
      return callUpstreamTool({
        store,
        upstreamRegistry,
        role: 'chat',
        projectId,
        args,
        forceReadOnly: !chatFullAccessForUpstream(store, projectId, args.upstreamId),
      });

    case 'unity_scene_overview':
      return callSemanticTool({ store, upstreamRegistry, role, projectId, args, semanticKey: 'sceneOverview' });

    case 'unity_console_read':
      return callSemanticTool({ store, upstreamRegistry, role, projectId, args, semanticKey: 'consoleRead' });

    case 'unity_screenshot':
      return callSemanticTool({ store, upstreamRegistry, role, projectId, args, semanticKey: 'screenshot' });

    case 'unity_call_tool':
      if (role !== 'codex' && role !== 'admin') throw new Error('unity_call_tool is only available to codex/admin roles.');
      return callUpstreamTool({ store, upstreamRegistry, role, projectId, args, forceReadOnly: false });

    case 'audit_list':
      return textResult(store.listAuditLogs(projectId, args.limit || 100));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function callUpstreamCatalog({ store, upstreamRegistry, role, projectId, args }) {
  requireFields(args, ['upstreamId']);
  const { upstream, client } = upstreamRegistry.getClient(projectId, args.upstreamId);
  try {
    const tools = await client.listTools();
    const detectedProfile = detectToolProfile(tools);
    const classifiedUpstream = detectedProfile && upstream.policy?.toolProfile !== detectedProfile
      ? store.upsertUpstream(projectId, {
          id: upstream.id,
          name: upstream.name,
          policy: { ...(upstream.policy || {}), toolProfile: detectedProfile },
        })
      : upstream;
    const categorized = tools.map((tool) => {
      const policy = isAllowed({ role, toolName: tool.name, upstream: classifiedUpstream });
      return {
        ...tool,
        devHubCategory: policy.category,
        devHubAllowedForCaller: policy.allowed,
        devHubSafety: safetyAnnotations(policy.category),
      };
    });
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: 'tools/list',
      argsSummary: '{}',
      resultSummary: `${categorized.length} tools`,
      allowed: true,
    });
    return textResult({ upstream: sanitizeUpstream(classifiedUpstream), tools: categorized });
  } catch (error) {
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: 'tools/list',
      argsSummary: '{}',
      resultSummary: '',
      allowed: false,
      error: error.message,
    });
    throw error;
  }
}

async function callSemanticTool({ store, upstreamRegistry, role, projectId, args, semanticKey }) {
  requireFields(args, ['upstreamId']);
  const upstream = store.getUpstream(projectId, args.upstreamId);
  if (!upstream) throw new Error(`Upstream not found: ${args.upstreamId}`);
  const toolName = upstream.semanticTools?.[semanticKey];
  if (!toolName) {
    throw new Error(`No semantic tool configured for ${semanticKey}. Configure upstream.semanticTools.${semanticKey} in the UI or state file.`);
  }
  return callUpstreamTool({
    store,
    upstreamRegistry,
    role: role === 'admin' ? 'admin' : 'chat',
    projectId,
    args: { upstreamId: args.upstreamId, toolName, arguments: args.arguments || {} },
    forceReadOnly: role !== 'admin',
  });
}

async function callUpstreamTool({ store, upstreamRegistry, role, projectId, args, forceReadOnly }) {
  requireFields(args, ['upstreamId', 'toolName']);
  const { upstream, client } = upstreamRegistry.getClient(projectId, args.upstreamId);
  const policy = isAllowed({
    role,
    toolName: args.toolName,
    upstream,
    confirm: Boolean(args.confirm),
    arguments: args.arguments || {},
  });
  const argsSummary = summarizeObject(args.arguments || {});

  if (forceReadOnly && policy.category !== 'read') {
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: args.toolName,
      argsSummary,
      resultSummary: '',
      allowed: false,
      error: `Read-only call blocked. Tool category: ${policy.category}`,
    });
    throw new Error(`Read-only call blocked. Tool ${args.toolName} classified as ${policy.category}.`);
  }

  if (!policy.allowed) {
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: args.toolName,
      argsSummary,
      resultSummary: '',
      allowed: false,
      error: policy.reason,
    });
    throw new Error(policy.reason);
  }

  try {
    const result = await client.callTool(args.toolName, args.arguments || {});
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: args.toolName,
      argsSummary,
      resultSummary: summarizeObject(result),
      allowed: true,
    });
    return textResult({
      upstream: sanitizeUpstream(upstream),
      toolName: args.toolName,
      category: policy.category,
      safety: safetyAnnotations(policy.category),
      result,
    });
  } catch (error) {
    store.logToolCall({
      projectId,
      role,
      upstreamId: args.upstreamId,
      toolName: args.toolName,
      argsSummary,
      resultSummary: '',
      allowed: true,
      error: error.message,
    });
    throw error;
  }
}

function sanitizeUpstream(upstream) {
  const { headers, env, ...safe } = upstream;
  return {
    ...safe,
    headers: headers && Object.keys(headers).length ? '[redacted]' : {},
    env: env && Object.keys(env).length ? '[redacted]' : {},
  };
}
