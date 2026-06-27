import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { inspectToolPolicy, isAllowed } from './policy.js';
import { detectToolProfile } from './toolProfiles.js';
import { readRequestBody, respondJson, respondText, safeJsonParse } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = normalize(join(__dirname, '..', 'public'));

export async function handleApiRequest({ req, res, store, upstreamRegistry }) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  try {
    if (path === '/api/health') {
      respondJson(res, 200, { ok: true, activeProjectId: store.getState().activeProjectId }, corsHeaders());
      return true;
    }

    if (path === '/api/state' && req.method === 'GET') {
      respondJson(res, 200, { ...store.getState(), storage: store.getStorageInfo() }, corsHeaders());
      return true;
    }

    if (path === '/api/projects' && req.method === 'GET') {
      respondJson(res, 200, { activeProjectId: store.getState().activeProjectId, projects: store.listProjects() }, corsHeaders());
      return true;
    }

    if (path === '/api/projects' && req.method === 'POST') {
      const body = await jsonBody(req);
      respondJson(res, 201, store.createProject(body), corsHeaders());
      return true;
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      const tail = projectMatch[2] || '';
      await handleProjectApi({ req, res, store, upstreamRegistry, projectId, tail, url });
      return true;
    }

    return false;
  } catch (error) {
    respondJson(res, 500, { error: error.message }, corsHeaders());
    return true;
  }
}

async function handleProjectApi({ req, res, store, upstreamRegistry, projectId, tail, url }) {
  if (tail === '' && req.method === 'GET') {
    respondJson(res, 200, store.getProject(projectId), corsHeaders());
    return;
  }

  if (tail === '' && req.method === 'PATCH') {
    respondJson(res, 200, store.updateProject(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  if (tail === 'active' && req.method === 'POST') {
    respondJson(res, 200, store.setActiveProject(projectId), corsHeaders());
    return;
  }

  if (tail === 'docs' && req.method === 'GET') {
    respondJson(res, 200, store.listDocuments(projectId), corsHeaders());
    return;
  }

  if (tail === 'docs' && req.method === 'POST') {
    respondJson(res, 201, store.writeDocument(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  const docMatch = tail.match(/^docs\/(.+)$/);
  if (docMatch && req.method === 'GET') {
    respondJson(res, 200, store.getDocument(projectId, decodeURIComponent(docMatch[1])), corsHeaders());
    return;
  }

  if (tail === 'vault' && req.method === 'GET') {
    respondJson(res, 200, store.listVaultNotes(projectId), corsHeaders());
    return;
  }

  if (tail === 'vault' && req.method === 'POST') {
    respondJson(res, 201, store.writeVaultNote(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  const vaultMatch = tail.match(/^vault\/(.+)$/);
  if (vaultMatch && req.method === 'GET') {
    respondJson(res, 200, store.getVaultNote(projectId, decodeURIComponent(vaultMatch[1])), corsHeaders());
    return;
  }

  if (tail === 'tasks' && req.method === 'GET') {
    respondJson(res, 200, store.listTasks(projectId, {
      status: url.searchParams.get('status') || '',
      includeArchived: url.searchParams.get('includeArchived') === 'true',
      archivedOnly: url.searchParams.get('archived') === 'true',
    }), corsHeaders());
    return;
  }

  if (tail === 'tasks' && req.method === 'POST') {
    respondJson(res, 201, store.createTask(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  const taskMatch = tail.match(/^tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'GET') {
    respondJson(res, 200, store.getTask(projectId, taskMatch[1]), corsHeaders());
    return;
  }

  if (taskMatch && req.method === 'PATCH') {
    respondJson(res, 200, store.updateTask(projectId, taskMatch[1], await jsonBody(req)), corsHeaders());
    return;
  }

  if (taskMatch && req.method === 'DELETE') {
    respondJson(res, 200, store.deleteTask(projectId, taskMatch[1]), corsHeaders());
    return;
  }

  if (tail === 'messages' && req.method === 'GET') {
    respondJson(res, 200, store.listMessages(projectId, url.searchParams.get('taskId')), corsHeaders());
    return;
  }

  if (tail === 'messages' && req.method === 'POST') {
    respondJson(res, 201, store.postMessage(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  if (tail === 'decisions' && req.method === 'GET') {
    respondJson(res, 200, store.listDecisions(projectId), corsHeaders());
    return;
  }

  if (tail === 'decisions' && req.method === 'POST') {
    respondJson(res, 201, store.recordDecision(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  if (tail === 'upstreams' && req.method === 'GET') {
    respondJson(res, 200, store.listUpstreams(projectId), corsHeaders());
    return;
  }

  if (tail === 'upstreams' && req.method === 'POST') {
    respondJson(res, 201, store.upsertUpstream(projectId, await jsonBody(req)), corsHeaders());
    return;
  }

  const upstreamToolsMatch = tail.match(/^upstreams\/([^/]+)\/tools$/);
  if (upstreamToolsMatch && req.method === 'POST') {
    const upstreamId = decodeURIComponent(upstreamToolsMatch[1]);
    const { upstream, client } = upstreamRegistry.getClient(projectId, upstreamId);
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
      const inspectedTools = tools.map((tool) => ({
        ...tool,
        policy: {
          ...inspectToolPolicy(tool.name, classifiedUpstream.policy),
          chat: isAllowed({ role: 'chat', toolName: tool.name, upstream: classifiedUpstream }),
          codex: isAllowed({ role: 'codex', toolName: tool.name, upstream: classifiedUpstream }),
        },
      }));
      store.logToolCall({
        projectId,
        role: 'admin',
        upstreamId,
        toolName: 'tools/list',
        argsSummary: 'Web UI connection test',
        resultSummary: `${tools.length} tools discovered`,
        allowed: true,
      });
      respondJson(res, 200, {
        connected: true,
        upstreamId,
        toolCount: tools.length,
        toolProfile: classifiedUpstream.policy?.toolProfile || null,
        tools: inspectedTools,
      }, corsHeaders());
    } catch (error) {
      store.logToolCall({
        projectId,
        role: 'admin',
        upstreamId,
        toolName: 'tools/list',
        argsSummary: 'Web UI connection test',
        allowed: true,
        error: error.message,
      });
      throw error;
    }
    return;
  }

  const upstreamMatch = tail.match(/^upstreams\/([^/]+)$/);
  if (upstreamMatch && req.method === 'GET') {
    respondJson(res, 200, store.getUpstream(projectId, upstreamMatch[1]), corsHeaders());
    return;
  }

  if (upstreamMatch && req.method === 'PATCH') {
    respondJson(res, 200, store.upsertUpstream(projectId, { ...(await jsonBody(req)), id: upstreamMatch[1] }), corsHeaders());
    return;
  }

  if (tail === 'audit' && req.method === 'GET') {
    respondJson(res, 200, store.listAuditLogs(projectId, Number(url.searchParams.get('limit') || 100)), corsHeaders());
    return;
  }

  respondJson(res, 404, { error: 'Not found' }, corsHeaders());
}

export function handleStaticRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const filePath = normalize(join(publicDir, path));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    respondText(res, 404, 'Not found');
    return;
  }
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType(filePath), 'Content-Length': content.length });
  res.end(content);
}

async function jsonBody(req) {
  const raw = await readRequestBody(req);
  return safeJsonParse(raw, {});
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, PATCH, DELETE, OPTIONS',
  };
}
