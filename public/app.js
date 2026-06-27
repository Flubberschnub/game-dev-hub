import { filterToolCatalog, toolCategoryLabel } from './toolCatalog.js';

let state = null;
let activeProjectId = null;
let discoveredTools = [];

const $ = (id) => document.getElementById(id);

const TASK_STATUS_LABELS = {
  idea: 'Idea',
  ready_for_codex: 'Ready for Codex',
  in_progress: 'In progress',
  codex_done: 'Codex done',
  review: 'Review',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  complete: 'Complete',
};

initializeTabs();

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const body = JSON.parse(text);
      message = body.error || text;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function load() {
  const nextState = await api('/api/state');
  const nextProjectId = nextState.activeProjectId || nextState.projects[0]?.id || null;
  if (activeProjectId && activeProjectId !== nextProjectId) resetWorkspaceForms();
  state = nextState;
  activeProjectId = nextProjectId;
  render();
}

function render() {
  renderProject();
  renderDocs();
  renderTasks();
  renderUpstreams();
  renderMessages();
  renderAudit();
  renderSnippets();
}

function renderProject() {
  const project = state.projects.find((p) => p.id === activeProjectId);
  $('projectSelect').innerHTML = state.projects
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  $('projectSelect').value = project?.id || '';

  $('projectSummary').innerHTML = project
    ? `<span class="muted">id: ${escapeHtml(project.id)} · project space: ${escapeHtml(state.storage?.projectSpacePath || '')}</span>`
    : 'No project found.';

  $('projectName').value = project?.name || '';
  $('projectRepoPath').value = project?.repoPath || '';
  $('projectUnityPath').value = project?.unityProjectPath || '';
  $('projectDocsPath').value = project?.docsPath || '';
  $('projectObsidianPath').value = project?.obsidianVaultPath || '';

  const upstreams = state.upstreams.filter((u) => u.projectId === activeProjectId);
  $('projectActiveUpstream').innerHTML = [
    '<option value="">No active upstream</option>',
    ...upstreams.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`),
  ].join('');
  $('projectActiveUpstream').value = project?.activeUpstreamId || '';
}

function renderDocs() {
  const docs = state.documents.filter((d) => d.projectId === activeProjectId);
  $('docsList').innerHTML = docs
    .map(
      (d) => `<div class="item"><strong>${escapeHtml(d.path)}</strong><span class="badge">${escapeHtml(d.kind)}</span> <span class="badge">${escapeHtml(d.source || d.storage || 'state')}</span><p>${escapeHtml(d.title)}</p><button data-doc="${d.path}">Load</button></div>`,
    )
    .join('');
  document.querySelectorAll('[data-doc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const doc = docs.find((d) => d.path === btn.dataset.doc);
      $('docPath').value = doc.path;
      $('docTitle').value = doc.title;
      $('docKind').value = doc.kind;
      $('docContent').value = doc.content;
      $('docAppend').checked = false;
    });
  });
}

function renderTasks() {
  const tasks = state.tasks.filter((t) => t.projectId === activeProjectId);
  const view = $('taskView').value || 'active';
  const visibleTasks = tasks.filter((task) => {
    const archived = Boolean(task.archivedAt);
    if (view === 'archived') return archived;
    if (view === 'all') return true;
    return !archived;
  });

  $('taskParentId').innerHTML = [
    '<option value="">No parent task</option>',
    ...tasks
      .filter((task) => !task.archivedAt)
      .map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)}</option>`),
  ].join('');

  $('tasksList').innerHTML = visibleTasks.length
    ? renderTaskTree(visibleTasks)
    : `<div class="catalog-empty">${view === 'archived' ? 'No archived tasks.' : 'No tasks in this view.'}</div>`;

  document.querySelectorAll('[data-task-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleTaskAction(btn.dataset.taskAction, btn.dataset.taskId));
  });
}

function renderTaskTree(tasks) {
  const byParent = new Map();
  const visibleIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    const parentId = visibleIds.has(task.parentTaskId) ? task.parentTaskId : '';
    const siblings = byParent.get(parentId) || [];
    siblings.push(task);
    byParent.set(parentId, siblings);
  }

  const renderBranch = (parentId = '', depth = 0) => (byParent.get(parentId) || [])
    .sort(compareTasks)
    .map((task) => {
      const archived = Boolean(task.archivedAt);
      const badges = [
        `<span class="badge">${escapeHtml(TASK_STATUS_LABELS[task.status] || task.status)}</span>`,
        `<span class="badge">${escapeHtml(task.assignedTo)}</span>`,
        archived ? '<span class="badge archived">archived</span>' : '',
      ].filter(Boolean).join(' ');
      const criteria = (task.acceptanceCriteria || []).length
        ? `<ul class="task-criteria">${task.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : '';
      const reviewNote = task.reviewNote
        ? `<p class="task-review-note"><strong>Review note:</strong> ${escapeHtml(task.reviewNote)}</p>`
        : '';
      const children = renderBranch(task.id, depth + 1);
      return `
        <div class="item task-item depth-${Math.min(depth, 4)}">
          <div class="task-title-row">
            <strong>${escapeHtml(task.title)}</strong>
            <span class="task-badges">${badges}</span>
          </div>
          <p>${escapeHtml(task.designIntent || '')}</p>
          ${reviewNote}
          ${criteria}
          <div class="task-actions">
            <button type="button" class="button compact" data-task-action="complete" data-task-id="${escapeHtml(task.id)}">Complete</button>
            <button type="button" class="button compact secondary" data-task-action="changes" data-task-id="${escapeHtml(task.id)}">Request Changes</button>
            ${archived
              ? `<button type="button" class="button compact secondary" data-task-action="unarchive" data-task-id="${escapeHtml(task.id)}">Restore</button>`
              : `<button type="button" class="button compact secondary" data-task-action="archive" data-task-id="${escapeHtml(task.id)}">Archive</button>`}
            <button type="button" class="button compact danger" data-task-action="delete" data-task-id="${escapeHtml(task.id)}">Delete</button>
          </div>
        </div>
        ${children ? `<div class="task-children">${children}</div>` : ''}`;
    })
    .join('');

  return renderBranch();
}

function compareTasks(a, b) {
  const aDone = ['complete', 'accepted'].includes(a.status);
  const bDone = ['complete', 'accepted'].includes(b.status);
  if (aDone !== bDone) return aDone ? 1 : -1;
  return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
}

async function handleTaskAction(action, taskId) {
  if (!activeProjectId || !taskId) return;
  const encodedProjectId = encodeURIComponent(activeProjectId);
  const encodedTaskId = encodeURIComponent(taskId);

  if (action === 'complete') {
    await api(`/api/projects/${encodedProjectId}/tasks/${encodedTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'complete', updatedBy: 'human', completedBy: 'human' }),
    });
  }

  if (action === 'changes') {
    const reviewNote = window.prompt('What needs to change before this task is complete?') || '';
    if (!reviewNote.trim()) return;
    await api(`/api/projects/${encodedProjectId}/tasks/${encodedTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        requestChanges: true,
        reviewNote,
        updatedBy: 'human',
        changesRequestedBy: 'human',
      }),
    });
    await api(`/api/projects/${encodedProjectId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ from: 'human', taskId, content: `Changes requested: ${reviewNote}` }),
    });
  }

  if (action === 'archive' || action === 'unarchive') {
    await api(`/api/projects/${encodedProjectId}/tasks/${encodedTaskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archive: action === 'archive', updatedBy: 'human', archivedBy: 'human' }),
    });
  }

  if (action === 'delete') {
    if (!window.confirm('Delete this task permanently? Subtasks will be moved up one level.')) return;
    await api(`/api/projects/${encodedProjectId}/tasks/${encodedTaskId}`, { method: 'DELETE' });
  }

  await load();
}

function renderUpstreams() {
  const upstreams = state.upstreams.filter((u) => u.projectId === activeProjectId);
  $('upstreamsList').innerHTML = upstreams
    .map(
      (u) => `<div class="item"><strong>${escapeHtml(u.name)}</strong><span class="badge">${escapeHtml(u.transport)}</span> <span class="badge">${u.enabled ? 'enabled' : 'disabled'}</span><p>${escapeHtml(u.url || u.command || '')}</p><button data-upstream="${u.id}">Load</button></div>`,
    )
    .join('');
  document.querySelectorAll('[data-upstream]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = upstreams.find((x) => x.id === btn.dataset.upstream);
      $('upstreamId').value = u.id;
      $('upstreamName').value = u.name;
      $('upstreamTransport').value = u.transport;
      $('upstreamUrl').value = u.url || '';
      $('upstreamCommand').value = u.command || '';
      $('upstreamArgs').value = JSON.stringify(u.args || [], null, 2);
      $('upstreamEnv').value = JSON.stringify(u.env || {}, null, 2);
      $('upstreamEnabled').checked = Boolean(u.enabled);
      $('semanticTools').value = JSON.stringify(u.semanticTools || {}, null, 2);
      $('policyJson').value = JSON.stringify(u.policy || {}, null, 2);
      $('chatFullAccess').checked = Boolean(u.policy?.chatFullAccess);
      clearToolCatalog();
    });
  });
}

function renderMessages() {
  const messages = state.messages.filter((m) => m.projectId === activeProjectId).slice(-8).reverse();
  $('messagesList').innerHTML = messages
    .map((m) => `<div class="item"><strong>${escapeHtml(m.from)}</strong><p>${escapeHtml(m.content)}</p><small>${escapeHtml(m.createdAt)}</small></div>`)
    .join('');
}

function renderAudit() {
  const logs = state.auditLogs.filter((l) => l.projectId === activeProjectId).slice(0, 8);
  $('auditList').innerHTML = logs
    .map(
      (l) => `<div class="item"><strong>${escapeHtml(l.toolName)}</strong><span class="badge">${escapeHtml(l.role)}</span> <span class="badge">${l.allowed ? 'allowed' : 'blocked'}</span><p>${escapeHtml(l.error || l.resultSummary || '')}</p><small>${escapeHtml(l.createdAt)}</small></div>`,
    )
    .join('');
}

function renderSnippets() {
  const origin = window.location.origin;
  $('snippets').textContent = `Codex .codex/config.toml:\n\n[mcp_servers.game_dev_hub]\nurl = "${origin}/mcp/codex"\nbearer_token_env_var = "DEVHUB_CODEX_TOKEN"\ntool_timeout_sec = 120\nenabled = true\n\nChatGPT connector URL:\n${origin}/mcp/chat\n\nLocal dev tokens, unless overridden in env:\nDEVHUB_CHAT_TOKEN=dev-chat-token\nDEVHUB_CODEX_TOKEN=dev-codex-token`;
}

$('refreshBtn').addEventListener('click', load);

$('taskView').addEventListener('change', renderTasks);

$('projectSelect').addEventListener('change', async () => {
  const projectId = $('projectSelect').value;
  if (!projectId || projectId === activeProjectId) return;
  await api(`/api/projects/${encodeURIComponent(projectId)}/active`, { method: 'POST' });
  await load();
});

$('saveProjectBtn').addEventListener('click', async () => {
  if (!activeProjectId) return;
  await api(`/api/projects/${encodeURIComponent(activeProjectId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: $('projectName').value,
      repoPath: $('projectRepoPath').value,
      unityProjectPath: $('projectUnityPath').value,
      docsPath: $('projectDocsPath').value,
      obsidianVaultPath: $('projectObsidianPath').value,
      activeUpstreamId: $('projectActiveUpstream').value,
    }),
  });
  await load();
});

$('createProjectBtn').addEventListener('click', async () => {
  const project = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: $('newProjectName').value,
      repoPath: $('newProjectRepoPath').value,
      unityProjectPath: $('newProjectUnityPath').value,
      docsPath: $('newProjectDocsPath').value,
      obsidianVaultPath: $('newProjectObsidianPath').value,
    }),
  });
  await api(`/api/projects/${encodeURIComponent(project.id)}/active`, { method: 'POST' });
  $('newProjectName').value = '';
  $('newProjectRepoPath').value = '';
  $('newProjectUnityPath').value = '';
  $('newProjectDocsPath').value = '';
  $('newProjectObsidianPath').value = '';
  await load();
});

$('saveDocBtn').addEventListener('click', async () => {
  await api(`/api/projects/${activeProjectId}/docs`, {
    method: 'POST',
    body: JSON.stringify({
      path: $('docPath').value,
      title: $('docTitle').value,
      kind: $('docKind').value,
      content: $('docContent').value,
      append: $('docAppend').checked,
    }),
  });
  await load();
});

$('createTaskBtn').addEventListener('click', async () => {
  await api(`/api/projects/${encodeURIComponent(activeProjectId)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      title: $('taskTitle').value,
      parentTaskId: $('taskParentId').value || null,
      status: $('taskStatus').value,
      designIntent: $('taskIntent').value,
      acceptanceCriteria: $('taskCriteria').value.split('\n').map((s) => s.trim()).filter(Boolean),
      assignedTo: $('taskAssignedTo').value,
      createdBy: 'human',
    }),
  });
  $('taskTitle').value = '';
  $('taskParentId').value = '';
  $('taskIntent').value = '';
  $('taskCriteria').value = '';
  await load();
});

$('saveUpstreamBtn').addEventListener('click', async () => {
  await saveUpstreamForm();
  await load();
});

$('inspectUpstreamBtn').addEventListener('click', async () => {
  setConnectionStatus('Connecting to upstream MCP...', '');
  try {
    const upstream = await saveUpstreamForm();
    const result = await api(
      `/api/projects/${encodeURIComponent(activeProjectId)}/upstreams/${encodeURIComponent(upstream.id)}/tools`,
      { method: 'POST' },
    );
    discoveredTools = result.tools || [];
    const profileText = result.toolProfile ? ` Auto-profile: ${result.toolProfile}.` : '';
    setConnectionStatus(`Connected successfully. Discovered ${result.toolCount} tools.${profileText}`, 'success');
    renderToolCatalog();
  } catch (error) {
    discoveredTools = [];
    renderToolCatalog();
    setConnectionStatus(`Connection failed: ${error.message}`, 'error');
  }
});

$('saveToolOverridesBtn').addEventListener('click', async () => {
  try {
    await saveUpstreamForm();
    setConnectionStatus(`Saved policy overrides for ${discoveredTools.length} discovered tools.`, 'success');
    await refreshToolCatalog();
  } catch (error) {
    setConnectionStatus(`Could not save overrides: ${error.message}`, 'error');
  }
});

async function saveUpstreamForm() {
  const policy = parseJsonObject($('policyJson').value, 'Policy');
  policy.chatFullAccess = $('chatFullAccess').checked;
  const upstream = await api(`/api/projects/${activeProjectId}/upstreams`, {
    method: 'POST',
    body: JSON.stringify({
      id: $('upstreamId').value,
      name: $('upstreamName').value,
      transport: $('upstreamTransport').value,
      url: $('upstreamUrl').value,
      command: $('upstreamCommand').value,
      args: parseJson($('upstreamArgs').value, []),
      env: parseJsonObject($('upstreamEnv').value, 'STDIO env'),
      enabled: $('upstreamEnabled').checked,
      semanticTools: parseJson($('semanticTools').value, {}),
      policy,
    }),
  });
  $('upstreamId').value = upstream.id;
  $('policyJson').value = JSON.stringify(upstream.policy || {}, null, 2);
  return upstream;
}

$('postMessageBtn').addEventListener('click', async () => {
  await api(`/api/projects/${activeProjectId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ from: $('messageFrom').value, content: $('messageContent').value }),
  });
  $('messageContent').value = '';
  await load();
});

function parseJson(text, fallback) {
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    alert(`Invalid JSON: ${error.message}`);
    throw error;
  }
}

function parseJsonObject(text, label) {
  const value = parseJson(text, {});
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    const error = new Error(`${label} must be a JSON object.`);
    alert(error.message);
    throw error;
  }
  return value;
}

function resetWorkspaceForms() {
  for (const id of [
    'docPath',
    'docTitle',
    'docContent',
    'taskTitle',
    'taskParentId',
    'taskIntent',
    'taskCriteria',
    'upstreamId',
    'projectDocsPath',
    'projectObsidianPath',
    'upstreamName',
    'upstreamUrl',
    'upstreamCommand',
    'upstreamArgs',
    'upstreamEnv',
    'semanticTools',
    'policyJson',
    'messageContent',
  ]) {
    $(id).value = '';
  }
  $('docAppend').checked = false;
  $('upstreamEnabled').checked = false;
  $('chatFullAccess').checked = false;
  clearToolCatalog();
}

async function refreshToolCatalog() {
  const upstreamId = $('upstreamId').value;
  const result = await api(
    `/api/projects/${encodeURIComponent(activeProjectId)}/upstreams/${encodeURIComponent(upstreamId)}/tools`,
    { method: 'POST' },
  );
  discoveredTools = result.tools || [];
  renderToolCatalog();
}

function renderToolCatalog() {
  const hasTools = discoveredTools.length > 0;
  const filter = $('toolCategoryFilter').value || 'all';
  const visibleTools = filterToolCatalog(discoveredTools, filter);
  $('saveToolOverridesBtn').hidden = !hasTools;
  $('toolCatalogControls').hidden = !hasTools;
  $('toolCatalogCount').textContent = filter === 'all'
    ? `${discoveredTools.length} tools`
    : `${visibleTools.length} of ${discoveredTools.length} tools`;
  $('upstreamToolCatalog').innerHTML = visibleTools.length
    ? visibleTools
      .map(({ tool, index, category }) => {
        const policy = tool.policy || {};
        const selected = policy.override || 'auto';
        const effective = category;
        const automaticDetail = policy.profileRule
          ? `${policy.automaticSource}: ${policy.profileRule}`
          : policy.matchedPattern
            ? `regex: ${policy.regexCategory} via ${policy.matchedPattern}`
            : 'regex: unknown (no match)';
        return `
        <details class="tool-entry category-${escapeHtml(effective)}">
          <summary>
            <code class="tool-entry-name">${escapeHtml(tool.name)}</code>
            <span class="tool-entry-summary-badges">
              <span class="badge category-badge category-${escapeHtml(effective)}">${escapeHtml(toolCategoryLabel(effective))}</span>
            </span>
          </summary>
          <div class="tool-entry-body">
            <p>${escapeHtml(tool.description || 'No description provided.')}</p>
            <div class="tool-policy-control">
              <div>
                <span class="badge">auto: ${escapeHtml(automaticDetail)}</span>
                <span class="badge">effective: ${escapeHtml(effective)}</span>
                ${toolAccessBadges(effective, policy)}
              </div>
              <label class="field">
                Manual classification
                <span class="help" tabindex="0" data-tooltip="Auto uses a detected MCP profile when available, then falls back to regex. A manual choice is stored as an exact override.">?</span>
                <select data-tool-policy-index="${index}">
                  ${toolPolicyOption('auto', 'Auto (profile / regex)', selected)}
                  ${toolPolicyOption('read', 'Read', selected)}
                  ${toolPolicyOption('write', 'Write', selected)}
                  ${toolPolicyOption('destructive', 'Destructive', selected)}
                  ${toolPolicyOption('deny', 'Deny', selected)}
                </select>
              </label>
            </div>
            <details class="advanced">
              <summary>Input schema</summary>
              <pre>${escapeHtml(JSON.stringify(tool.inputSchema || {}, null, 2))}</pre>
            </details>
          </div>
        </details>`;
      })
      .join('')
    : '<div class="catalog-empty">No tools match this category.</div>';

  document.querySelectorAll('[data-tool-policy-index]').forEach((select) => {
    select.addEventListener('change', () => {
      const tool = discoveredTools[Number(select.dataset.toolPolicyIndex)];
      const policy = parseJsonObject($('policyJson').value, 'Policy');
      policy.overrides = policy.overrides || {};
      if (select.value === 'auto') delete policy.overrides[tool.name];
      else policy.overrides[tool.name] = select.value;
      tool.policy.override = select.value === 'auto' ? null : select.value;
      $('policyJson').value = JSON.stringify(policy, null, 2);
      renderToolCatalog();
    });
  });
}

$('toolCategoryFilter').addEventListener('change', renderToolCatalog);

function toolPolicyOption(value, label, selected) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

function toolAccessBadges(category, policy = {}) {
  if (policy.chat || policy.codex) {
    const chatText = policy.chat?.allowed ? 'allowed' : 'denied';
    const codexText = policy.codex?.requiresConfirmation ? 'confirmation' : policy.codex?.allowed ? 'allowed' : 'denied';
    return `<span class="badge">Chat: ${chatText}</span> <span class="badge">Codex: ${codexText}</span>`;
  }
  if (category === 'read') return '<span class="badge">Chat: allowed</span> <span class="badge">Codex: allowed</span>';
  if (category === 'destructive') return '<span class="badge">Chat: denied</span> <span class="badge">Codex: confirmation</span>';
  if (category === 'deny') return '<span class="badge">Chat: denied</span> <span class="badge">Codex: denied</span>';
  if (category === 'write') return '<span class="badge">Chat: denied</span> <span class="badge">Codex: allowed</span>';
  return '<span class="badge">Access: project defaults</span>';
}

function setConnectionStatus(message, kind) {
  $('upstreamConnectionStatus').textContent = message;
  $('upstreamConnectionStatus').className = `connection-status ${kind || 'muted'}`;
}

function clearToolCatalog() {
  discoveredTools = [];
  $('toolCategoryFilter').value = 'all';
  $('toolCatalogControls').hidden = true;
  $('toolCatalogCount').textContent = '';
  $('upstreamToolCatalog').innerHTML = '';
  $('saveToolOverridesBtn').hidden = true;
  setConnectionStatus('No connection test run.', '');
}

function initializeTabs() {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const panels = [...document.querySelectorAll('[data-tab-panel]')];
  const storedTab = sessionStorage.getItem('gameDevHubActiveTab');
  const initialTab = tabs.some((tab) => tab.dataset.tab === storedTab) ? storedTab : 'project';

  const activate = (tabName) => {
    for (const tab of tabs) {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of panels) {
      const active = panel.dataset.tabPanel === tabName;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
    sessionStorage.setItem('gameDevHubActiveTab', tabName);
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab.dataset.tab));
  }
  activate(initialTab);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

load().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
