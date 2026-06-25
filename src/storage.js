import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createDefaultState } from './defaultState.js';
import { deepClone, id, nowIso, sanitizePathSegment } from './utils.js';

export class JsonStore {
  constructor(filePath) {
    this.filePath = resolve(filePath || './data/state.json');
    this.state = null;
  }

  load() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.state = createDefaultState();
      this.save();
      return this.state;
    }
    const raw = readFileSync(this.filePath, 'utf8');
    this.state = JSON.parse(raw);
    return this.state;
  }

  save() {
    if (!this.state) throw new Error('Cannot save before loading store.');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);
  }

  getState() {
    if (!this.state) this.load();
    return this.state;
  }

  listProjects() {
    return deepClone(this.getState().projects);
  }

  getActiveProject() {
    const state = this.getState();
    return this.getProject(state.activeProjectId) || state.projects[0] || null;
  }

  setActiveProject(projectId) {
    const state = this.getState();
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    state.activeProjectId = projectId;
    this.save();
    return deepClone(project);
  }

  getProject(projectId) {
    const state = this.getState();
    const project = state.projects.find((p) => p.id === projectId);
    return project ? deepClone(project) : null;
  }

  createProject({ name, repoPath = '', unityProjectPath = '' }) {
    name = String(name || '').trim();
    if (!name) throw new Error('Project name is required.');
    const state = this.getState();
    const createdAt = nowIso();
    const projectId = sanitizePathSegment(name.toLowerCase()).replaceAll('.', '-') || id('project');
    const finalId = state.projects.some((p) => p.id === projectId) ? id('project') : projectId;
    const project = {
      id: finalId,
      name,
      repoPath,
      unityProjectPath,
      activeUpstreamId: '',
      createdAt,
      updatedAt: createdAt,
    };
    state.projects.push(project);
    state.documents.push(...createStarterDocuments(project.id, createdAt));
    this.save();
    return deepClone(project);
  }

  updateProject(projectId, patch) {
    const state = this.getState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (patch.name !== undefined && !String(patch.name).trim()) {
      throw new Error('Project name is required.');
    }
    if (
      patch.activeUpstreamId
      && !state.upstreams.some((upstream) => upstream.projectId === projectId && upstream.id === patch.activeUpstreamId)
    ) {
      throw new Error(`Upstream not found for project ${projectId}: ${patch.activeUpstreamId}`);
    }
    for (const key of ['name', 'repoPath', 'unityProjectPath', 'activeUpstreamId']) {
      if (patch[key] !== undefined) project[key] = key === 'name' ? String(patch[key]).trim() : patch[key];
    }
    project.updatedAt = nowIso();
    this.save();
    return deepClone(project);
  }

  listDocuments(projectId) {
    const state = this.getState();
    return deepClone(state.documents.filter((d) => d.projectId === projectId));
  }

  getDocument(projectId, pathOrId) {
    const state = this.getState();
    const doc = state.documents.find((d) => d.projectId === projectId && (d.id === pathOrId || d.path === pathOrId));
    return doc ? deepClone(doc) : null;
  }

  writeDocument(projectId, { path, title, kind = 'design', content, append = false }) {
    if (!path) throw new Error('Document path is required.');
    if (content === undefined) throw new Error('Document content is required.');
    const state = this.getState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const existing = state.documents.find((d) => d.projectId === projectId && d.path === path);
    const timestamp = nowIso();
    if (existing) {
      existing.title = title || existing.title;
      existing.kind = kind || existing.kind;
      existing.content = append ? `${existing.content}\n${content}` : content;
      existing.updatedAt = timestamp;
      this.save();
      return deepClone(existing);
    }
    const doc = {
      id: id('doc'),
      projectId,
      path,
      title: title || path,
      kind,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.documents.push(doc);
    this.save();
    return deepClone(doc);
  }

  searchDocuments(projectId, query) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    return this.listDocuments(projectId)
      .map((doc) => {
        const haystack = `${doc.path}\n${doc.title}\n${doc.kind}\n${doc.content}`.toLowerCase();
        const idx = haystack.indexOf(q);
        if (idx === -1) return null;
        const start = Math.max(0, idx - 160);
        const end = Math.min(haystack.length, idx + q.length + 300);
        return {
          id: doc.id,
          path: doc.path,
          title: doc.title,
          kind: doc.kind,
          snippet: doc.content.slice(start, end),
        };
      })
      .filter(Boolean);
  }

  listTasks(projectId, status) {
    const state = this.getState();
    return deepClone(state.tasks.filter((t) => t.projectId === projectId && (!status || t.status === status)));
  }

  getTask(projectId, taskId) {
    const state = this.getState();
    const task = state.tasks.find((t) => t.projectId === projectId && t.id === taskId);
    return task ? deepClone(task) : null;
  }

  createTask(projectId, input) {
    if (!input.title) throw new Error('Task title is required.');
    const state = this.getState();
    requireProject(state, projectId);
    const timestamp = nowIso();
    const task = {
      id: id('task'),
      projectId,
      title: input.title,
      status: input.status || 'idea',
      designIntent: input.designIntent || '',
      implementationNotes: input.implementationNotes || '',
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
      assignedTo: input.assignedTo || 'human',
      createdBy: input.createdBy || 'human',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.tasks.push(task);
    this.save();
    return deepClone(task);
  }

  updateTask(projectId, taskId, patch) {
    const state = this.getState();
    const task = state.tasks.find((t) => t.projectId === projectId && t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    for (const key of ['title', 'status', 'designIntent', 'implementationNotes', 'acceptanceCriteria', 'assignedTo']) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }
    task.updatedAt = nowIso();
    this.save();
    return deepClone(task);
  }

  listMessages(projectId, taskId) {
    const state = this.getState();
    return deepClone(state.messages.filter((m) => m.projectId === projectId && (!taskId || m.taskId === taskId)));
  }

  postMessage(projectId, input) {
    if (!input.content) throw new Error('Message content is required.');
    const state = this.getState();
    requireProject(state, projectId);
    const msg = {
      id: id('msg'),
      projectId,
      taskId: input.taskId || null,
      from: input.from || 'human',
      content: input.content,
      createdAt: nowIso(),
    };
    state.messages.push(msg);
    this.save();
    return deepClone(msg);
  }

  listDecisions(projectId) {
    const state = this.getState();
    return deepClone(state.decisions.filter((d) => d.projectId === projectId));
  }

  recordDecision(projectId, input) {
    if (!input.title) throw new Error('Decision title is required.');
    const state = this.getState();
    requireProject(state, projectId);
    const decision = {
      id: id('decision'),
      projectId,
      title: input.title,
      rationale: input.rationale || '',
      consequences: input.consequences || '',
      createdBy: input.createdBy || 'human',
      createdAt: nowIso(),
    };
    state.decisions.push(decision);
    this.save();
    return deepClone(decision);
  }

  listUpstreams(projectId) {
    const state = this.getState();
    return deepClone(state.upstreams.filter((u) => u.projectId === projectId));
  }

  getUpstream(projectId, upstreamId) {
    const state = this.getState();
    const upstream = state.upstreams.find((u) => u.projectId === projectId && u.id === upstreamId);
    return upstream ? deepClone(upstream) : null;
  }

  upsertUpstream(projectId, input) {
    if (!input.name) throw new Error('Upstream name is required.');
    const state = this.getState();
    requireProject(state, projectId);
    const timestamp = nowIso();
    const targetId = input.id || id('upstream');
    let upstream = state.upstreams.find((u) => u.projectId === projectId && u.id === targetId);
    if (!upstream) {
      upstream = {
        id: targetId,
        projectId,
        name: input.name,
        transport: input.transport || 'streamable_http',
        url: input.url || '',
        command: input.command || '',
        args: input.args || [],
        env: normalizeEnvironment(input.env),
        headers: input.headers || {},
        enabled: Boolean(input.enabled),
        semanticTools: input.semanticTools || {},
        policy: input.policy || {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.upstreams.push(upstream);
    } else {
      for (const key of ['name', 'transport', 'url', 'command', 'args', 'headers', 'enabled', 'semanticTools', 'policy']) {
        if (input[key] !== undefined) upstream[key] = input[key];
      }
      if (input.env !== undefined) upstream.env = normalizeEnvironment(input.env);
      upstream.updatedAt = timestamp;
    }
    this.save();
    return deepClone(upstream);
  }

  logToolCall(input) {
    const state = this.getState();
    const entry = {
      id: id('audit'),
      projectId: input.projectId,
      role: input.role,
      upstreamId: input.upstreamId || null,
      toolName: input.toolName,
      argsSummary: input.argsSummary || '',
      resultSummary: input.resultSummary || '',
      allowed: Boolean(input.allowed),
      error: input.error || null,
      createdAt: nowIso(),
    };
    state.auditLogs.unshift(entry);
    state.auditLogs = state.auditLogs.slice(0, 1000);
    this.save();
    return deepClone(entry);
  }

  listAuditLogs(projectId, limit = 100) {
    const state = this.getState();
    return deepClone(state.auditLogs.filter((l) => l.projectId === projectId).slice(0, limit));
  }
}

function createStarterDocuments(projectId, timestamp) {
  return [
    {
      path: 'AGENTS.md',
      title: 'Agent Instructions',
      kind: 'agent_instruction',
      content: '# AGENTS.md\n\nAdd project-specific agent instructions here.\n',
    },
    {
      path: 'GAME_DESIGN.md',
      title: 'Game Design Notes',
      kind: 'design',
      content: '# Game Design Notes\n\nAdd project-specific gameplay and design notes here.\n',
    },
    {
      path: 'TECHNICAL_DESIGN.md',
      title: 'Technical Design Notes',
      kind: 'technical',
      content: '# Technical Design Notes\n\nAdd project-specific architecture and implementation notes here.\n',
    },
  ].map((document) => ({
    id: id('doc'),
    projectId,
    ...document,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
}

function requireProject(state, projectId) {
  if (!state.projects.some((project) => project.id === projectId)) {
    throw new Error(`Project not found: ${projectId}`);
  }
}

function normalizeEnvironment(env = {}) {
  if (!env || Array.isArray(env) || typeof env !== 'object') {
    throw new Error('Upstream env must be a JSON object.');
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!key) throw new Error('Upstream env variable names cannot be empty.');
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new Error(`Upstream env value for ${key} must be a string, number, or boolean.`);
      }
      return [key, String(value)];
    }),
  );
}
