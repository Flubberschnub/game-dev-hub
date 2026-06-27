import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createDefaultState } from './defaultState.js';
import { deepClone, id, nowIso, sanitizePathSegment } from './utils.js';

export class JsonStore {
  constructor(filePath, options = {}) {
    this.filePath = resolve(filePath || './data/state.json');
    this.projectSpacePath = resolve(options.projectSpacePath || process.env.DEVHUB_PROJECT_SPACE || join(dirname(this.filePath), 'projects'));
    this.state = null;
  }

  load() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.state = createDefaultState();
      this.migrateStateForFileStorage();
      this.save();
      return this.state;
    }
    const raw = readFileSync(this.filePath, 'utf8');
    this.state = JSON.parse(raw);
    if (this.migrateStateForFileStorage()) {
      this.save();
    }
    return this.state;
  }

  save() {
    if (!this.state) throw new Error('Cannot save before loading store.');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const persisted = this.createPersistedState();
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2));
    renameSync(tmp, this.filePath);
  }

  getState() {
    if (!this.state) this.load();
    return this.state;
  }

  getStorageInfo() {
    return {
      dataFile: this.filePath,
      projectSpacePath: this.projectSpacePath,
    };
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

  createProject({ name, repoPath = '', unityProjectPath = '', docsPath = '', obsidianVaultPath = '' }) {
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
      docsPath,
      obsidianVaultPath,
      activeUpstreamId: '',
      createdAt,
      updatedAt: createdAt,
    };
    state.projects.push(project);
    state.documents.push(...createStarterDocuments(project.id, createdAt));
    for (const document of state.documents.filter((doc) => doc.projectId === project.id)) {
      this.writeDocumentFile(project, document.path, document.content || '');
      document.storage = 'file';
      document.source = 'project';
    }
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
    const previousDocsRoot = this.getProjectDocsRoot(project);
    for (const key of ['name', 'repoPath', 'unityProjectPath', 'docsPath', 'obsidianVaultPath', 'activeUpstreamId']) {
      if (patch[key] !== undefined) project[key] = key === 'name' ? String(patch[key]).trim() : patch[key];
    }
    const nextDocsRoot = this.getProjectDocsRoot(project);
    if (nextDocsRoot !== previousDocsRoot) {
      this.moveProjectDocuments(projectId, previousDocsRoot, nextDocsRoot);
    }
    project.updatedAt = nowIso();
    this.save();
    return deepClone(project);
  }

  listDocuments(projectId) {
    const state = this.getState();
    this.syncProjectDocuments(projectId);
    return deepClone(state.documents.filter((d) => d.projectId === projectId));
  }

  getDocument(projectId, pathOrId) {
    const state = this.getState();
    this.syncProjectDocuments(projectId);
    const doc = state.documents.find((d) => d.projectId === projectId && (d.id === pathOrId || d.path === pathOrId));
    if (doc) this.hydrateDocumentContent(requireProject(state, projectId), doc);
    return doc ? deepClone(doc) : null;
  }

  writeDocument(projectId, { path, title, kind = 'design', content, append = false }) {
    if (!path) throw new Error('Document path is required.');
    if (content === undefined) throw new Error('Document content is required.');
    const documentPath = normalizeMarkdownPath(path);
    const state = this.getState();
    const project = requireProject(state, projectId);
    this.syncProjectDocuments(projectId);
    const existing = state.documents.find((d) => d.projectId === projectId && d.path === documentPath);
    const timestamp = nowIso();
    if (existing) {
      this.hydrateDocumentContent(project, existing);
      existing.title = title || existing.title;
      existing.kind = kind || existing.kind;
      existing.content = append ? `${existing.content}\n${content}` : content;
      existing.storage = 'file';
      existing.source = 'project';
      existing.updatedAt = timestamp;
      this.writeDocumentFile(project, existing.path, existing.content);
      this.save();
      return deepClone(existing);
    }
    const doc = {
      id: id('doc'),
      projectId,
      path: documentPath,
      title: title || titleFromMarkdownPath(documentPath),
      kind,
      content,
      storage: 'file',
      source: 'project',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.documents.push(doc);
    this.writeDocumentFile(project, doc.path, doc.content);
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

  listVaultNotes(projectId) {
    const project = requireProject(this.getState(), projectId);
    const vaultRoot = this.getObsidianVaultRoot(project);
    return listMarkdownFiles(vaultRoot).map((notePath) => {
      const filePath = resolveWithinRoot(vaultRoot, notePath);
      const stats = statSync(filePath);
      return {
        path: notePath,
        title: titleFromMarkdownPath(notePath),
        kind: 'obsidian',
        source: 'obsidian',
        contentLength: readFileSync(filePath, 'utf8').length,
        updatedAt: stats.mtime.toISOString(),
      };
    });
  }

  getVaultNote(projectId, path) {
    const project = requireProject(this.getState(), projectId);
    const notePath = normalizeMarkdownPath(path);
    const vaultRoot = this.getObsidianVaultRoot(project);
    const filePath = resolveWithinRoot(vaultRoot, notePath);
    if (!existsSync(filePath)) return null;
    const stats = statSync(filePath);
    return {
      path: notePath,
      title: titleFromMarkdownPath(notePath),
      kind: 'obsidian',
      source: 'obsidian',
      content: readFileSync(filePath, 'utf8'),
      updatedAt: stats.mtime.toISOString(),
    };
  }

  writeVaultNote(projectId, { path, content, append = false }) {
    if (!path) throw new Error('Vault note path is required.');
    if (content === undefined) throw new Error('Vault note content is required.');
    const project = requireProject(this.getState(), projectId);
    const notePath = normalizeMarkdownPath(path);
    const vaultRoot = this.getObsidianVaultRoot(project);
    const filePath = resolveWithinRoot(vaultRoot, notePath);
    mkdirSync(dirname(filePath), { recursive: true });
    const nextContent = append && existsSync(filePath)
      ? `${readFileSync(filePath, 'utf8')}\n${content}`
      : content;
    writeFileSync(filePath, nextContent);
    return this.getVaultNote(projectId, notePath);
  }

  searchVaultNotes(projectId, query) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    return this.listVaultNotes(projectId)
      .map((note) => {
        const full = this.getVaultNote(projectId, note.path);
        const haystack = `${full.path}\n${full.title}\n${full.content}`.toLowerCase();
        const idx = haystack.indexOf(q);
        if (idx === -1) return null;
        const start = Math.max(0, idx - 160);
        const end = Math.min(full.content.length, idx + q.length + 300);
        return {
          path: full.path,
          title: full.title,
          kind: full.kind,
          source: full.source,
          snippet: full.content.slice(start, end),
        };
      })
      .filter(Boolean);
  }

  listTasks(projectId, filters = {}) {
    const state = this.getState();
    this.hydrateProjectTextRecords(projectId);
    const options = typeof filters === 'string' ? { status: filters } : filters || {};
    const includeArchived = Boolean(options.includeArchived);
    const archivedOnly = Boolean(options.archivedOnly);
    return deepClone(state.tasks.filter((task) => {
      if (task.projectId !== projectId) return false;
      if (options.status && task.status !== options.status) return false;
      const archived = Boolean(task.archivedAt);
      if (archivedOnly) return archived;
      if (!includeArchived && archived) return false;
      return true;
    }));
  }

  getTask(projectId, taskId) {
    const state = this.getState();
    this.hydrateProjectTextRecords(projectId);
    const task = state.tasks.find((t) => t.projectId === projectId && t.id === taskId);
    return task ? deepClone(task) : null;
  }

  createTask(projectId, input) {
    if (!input.title) throw new Error('Task title is required.');
    const state = this.getState();
    const project = requireProject(state, projectId);
    if (input.parentTaskId) requireTask(state, projectId, input.parentTaskId);
    const timestamp = nowIso();
    const task = {
      id: id('task'),
      projectId,
      title: input.title,
      parentTaskId: input.parentTaskId || null,
      status: input.status || 'idea',
      designIntent: input.designIntent || '',
      implementationNotes: input.implementationNotes || '',
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
      assignedTo: input.assignedTo || 'human',
      createdBy: input.createdBy || 'human',
      completedAt: null,
      completedBy: null,
      changesRequestedAt: null,
      changesRequestedBy: null,
      reviewNote: '',
      archivedAt: null,
      archivedBy: null,
      textPath: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    task.textPath = task.textPath || createRecordPath('tasks', task.title, task.id);
    state.tasks.push(task);
    this.writeTaskTextFile(project, task);
    this.save();
    return deepClone(task);
  }

  updateTask(projectId, taskId, patch) {
    const state = this.getState();
    const project = requireProject(state, projectId);
    this.hydrateProjectTextRecords(projectId);
    const task = state.tasks.find((t) => t.projectId === projectId && t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (patch.parentTaskId !== undefined) {
      if (patch.parentTaskId === taskId) throw new Error('A task cannot be its own parent.');
      if (patch.parentTaskId) {
        const parent = requireTask(state, projectId, patch.parentTaskId);
        if (isDescendantTask(state, projectId, parent.id, taskId)) {
          throw new Error('A task cannot be moved under one of its subtasks.');
        }
      }
    }

    for (const key of ['title', 'status', 'designIntent', 'implementationNotes', 'acceptanceCriteria', 'assignedTo', 'parentTaskId', 'reviewNote']) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }

    const timestamp = nowIso();
    if (patch.archive !== undefined) {
      if (patch.archive) {
        task.archivedAt = task.archivedAt || timestamp;
        task.archivedBy = patch.archivedBy || patch.updatedBy || 'human';
      } else {
        task.archivedAt = null;
        task.archivedBy = null;
      }
    }

    if (patch.requestChanges) {
      task.status = 'changes_requested';
      task.changesRequestedAt = timestamp;
      task.changesRequestedBy = patch.changesRequestedBy || patch.updatedBy || 'human';
      task.completedAt = null;
      task.completedBy = null;
    }

    if (patch.status === 'complete') {
      task.completedAt = task.completedAt || timestamp;
      task.completedBy = patch.completedBy || patch.updatedBy || 'human';
    } else if (patch.status === 'changes_requested') {
      task.changesRequestedAt = task.changesRequestedAt || timestamp;
      task.changesRequestedBy = patch.changesRequestedBy || patch.updatedBy || 'human';
      task.completedAt = null;
      task.completedBy = null;
    }

    task.updatedAt = nowIso();
    task.textPath = task.textPath || createRecordPath('tasks', task.title, task.id);
    this.writeTaskTextFile(project, task);
    this.save();
    return deepClone(task);
  }

  deleteTask(projectId, taskId) {
    const state = this.getState();
    const index = state.tasks.findIndex((task) => task.projectId === projectId && task.id === taskId);
    if (index === -1) throw new Error(`Task not found: ${taskId}`);
    const [deleted] = state.tasks.splice(index, 1);
    for (const task of state.tasks.filter((item) => item.projectId === projectId && item.parentTaskId === taskId)) {
      task.parentTaskId = deleted.parentTaskId || null;
      task.updatedAt = nowIso();
    }
    this.save();
    return deepClone(deleted);
  }

  listMessages(projectId, taskId) {
    const state = this.getState();
    this.hydrateProjectTextRecords(projectId);
    return deepClone(state.messages.filter((m) => m.projectId === projectId && (!taskId || m.taskId === taskId)));
  }

  postMessage(projectId, input) {
    if (!input.content) throw new Error('Message content is required.');
    const state = this.getState();
    const project = requireProject(state, projectId);
    const createdAt = nowIso();
    const msg = {
      id: id('msg'),
      projectId,
      taskId: input.taskId || null,
      from: input.from || 'human',
      content: input.content,
      textPath: '',
      createdAt,
    };
    msg.textPath = createRecordPath('messages', `${createdAt}-${msg.from}`, msg.id);
    state.messages.push(msg);
    this.writeMessageTextFile(project, msg);
    this.save();
    return deepClone(msg);
  }

  listDecisions(projectId) {
    const state = this.getState();
    this.hydrateProjectTextRecords(projectId);
    return deepClone(state.decisions.filter((d) => d.projectId === projectId));
  }

  recordDecision(projectId, input) {
    if (!input.title) throw new Error('Decision title is required.');
    const state = this.getState();
    const project = requireProject(state, projectId);
    const decision = {
      id: id('decision'),
      projectId,
      title: input.title,
      rationale: input.rationale || '',
      consequences: input.consequences || '',
      createdBy: input.createdBy || 'human',
      textPath: '',
      createdAt: nowIso(),
    };
    decision.textPath = createRecordPath('decisions', decision.title, decision.id);
    state.decisions.push(decision);
    this.writeDecisionTextFile(project, decision);
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
    const project = state.projects.find((item) => item.id === input.projectId);
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
      textPath: '',
      createdAt: nowIso(),
    };
    entry.textPath = createRecordPath('audit', `${entry.createdAt}-${entry.toolName}`, entry.id);
    state.auditLogs.unshift(entry);
    state.auditLogs = state.auditLogs.slice(0, 1000);
    if (project) this.writeAuditTextFile(project, entry);
    this.save();
    return deepClone(entry);
  }

  listAuditLogs(projectId, limit = 100) {
    const state = this.getState();
    this.hydrateProjectTextRecords(projectId);
    return deepClone(state.auditLogs.filter((l) => l.projectId === projectId).slice(0, limit));
  }

  migrateStateForFileStorage() {
    const state = this.getState();
    let changed = false;
    mkdirSync(this.projectSpacePath, { recursive: true });
    const schemaVersion = Number(state.schemaVersion || 1);
    if (schemaVersion < 3) {
      state.schemaVersion = 3;
      changed = true;
    }
    for (const project of state.projects) {
      if (project.docsPath === undefined) {
        project.docsPath = '';
        changed = true;
      }
      if (project.obsidianVaultPath === undefined) {
        project.obsidianVaultPath = '';
        changed = true;
      }
      mkdirSync(this.getProjectDocsRoot(project), { recursive: true });
    }
    for (const doc of state.documents) {
      const project = state.projects.find((item) => item.id === doc.projectId);
      if (!project) continue;
      const normalizedPath = normalizeMarkdownPath(doc.path);
      if (doc.path !== normalizedPath) {
        doc.path = normalizedPath;
        changed = true;
      }
      if (!doc.title) {
        doc.title = titleFromMarkdownPath(doc.path);
        changed = true;
      }
      if (!doc.kind) {
        doc.kind = 'markdown';
        changed = true;
      }
      if (doc.storage !== 'file') {
        doc.storage = 'file';
        changed = true;
      }
      if (doc.source !== 'project') {
        doc.source = 'project';
        changed = true;
      }
      if (doc.content !== undefined) {
        this.writeDocumentFile(project, doc.path, doc.content);
        changed = true;
      }
      this.hydrateDocumentContent(project, doc);
    }
    for (const project of state.projects) {
      changed = this.migrateProjectTextRecords(project) || changed;
    }
    return changed;
  }

  createPersistedState() {
    const persisted = deepClone(this.state);
    persisted.documents = persisted.documents.map(({ content, ...doc }) => doc);
    persisted.tasks = persisted.tasks.map((task) => {
      const {
        designIntent,
        implementationNotes,
        acceptanceCriteria,
        reviewNote,
        ...metadata
      } = task;
      return metadata;
    });
    persisted.messages = persisted.messages.map(({ content, ...metadata }) => metadata);
    persisted.decisions = persisted.decisions.map(({ rationale, consequences, ...metadata }) => metadata);
    persisted.auditLogs = persisted.auditLogs.map(({ argsSummary, resultSummary, error, ...metadata }) => metadata);
    persisted.storage = this.getStorageInfo();
    return persisted;
  }

  syncProjectDocuments(projectId) {
    const state = this.getState();
    const project = requireProject(state, projectId);
    const root = this.getProjectDocsRoot(project);
    mkdirSync(root, { recursive: true });
    let changed = false;
    for (const filePath of listMarkdownFiles(root)) {
      if (!state.documents.some((doc) => doc.projectId === projectId && doc.path === filePath)) {
        const timestamp = nowIso();
        state.documents.push({
          id: id('doc'),
          projectId,
          path: filePath,
          title: titleFromMarkdownPath(filePath),
          kind: 'markdown',
          storage: 'file',
          source: 'project',
          content: readFileSync(resolveWithinRoot(root, filePath), 'utf8'),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        changed = true;
      }
    }
    for (const doc of state.documents.filter((item) => item.projectId === projectId)) {
      this.hydrateDocumentContent(project, doc);
    }
    if (changed) this.save();
  }

  hydrateDocumentContent(project, doc) {
    const filePath = this.getDocumentFilePath(project, doc.path);
    doc.content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : doc.content || '';
  }

  writeDocumentFile(project, path, content) {
    const filePath = this.getDocumentFilePath(project, path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  hydrateProjectTextRecords(projectId) {
    const state = this.getState();
    const project = requireProject(state, projectId);
    for (const task of state.tasks.filter((item) => item.projectId === projectId)) {
      this.hydrateTaskText(project, task);
    }
    for (const message of state.messages.filter((item) => item.projectId === projectId)) {
      this.hydrateMessageText(project, message);
    }
    for (const decision of state.decisions.filter((item) => item.projectId === projectId)) {
      this.hydrateDecisionText(project, decision);
    }
    for (const entry of state.auditLogs.filter((item) => item.projectId === projectId)) {
      this.hydrateAuditText(project, entry);
    }
  }

  migrateProjectTextRecords(project) {
    let changed = false;
    for (const task of this.state.tasks.filter((item) => item.projectId === project.id)) {
      if (!task.textPath) {
        task.textPath = createRecordPath('tasks', task.title, task.id);
        changed = true;
      }
      const filePath = this.getRecordFilePath(project, task.textPath);
      if (existsSync(filePath)) {
        this.hydrateTaskText(project, task);
      } else {
        task.designIntent = task.designIntent || '';
        task.implementationNotes = task.implementationNotes || '';
        task.acceptanceCriteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
        task.reviewNote = task.reviewNote || '';
        this.writeTaskTextFile(project, task);
        changed = true;
      }
    }
    for (const message of this.state.messages.filter((item) => item.projectId === project.id)) {
      if (!message.textPath) {
        message.textPath = createRecordPath('messages', `${message.createdAt || ''}-${message.from || 'message'}`, message.id);
        changed = true;
      }
      const filePath = this.getRecordFilePath(project, message.textPath);
      if (existsSync(filePath)) {
        this.hydrateMessageText(project, message);
      } else {
        message.content = message.content || '';
        this.writeMessageTextFile(project, message);
        changed = true;
      }
    }
    for (const decision of this.state.decisions.filter((item) => item.projectId === project.id)) {
      if (!decision.textPath) {
        decision.textPath = createRecordPath('decisions', decision.title, decision.id);
        changed = true;
      }
      const filePath = this.getRecordFilePath(project, decision.textPath);
      if (existsSync(filePath)) {
        this.hydrateDecisionText(project, decision);
      } else {
        decision.rationale = decision.rationale || '';
        decision.consequences = decision.consequences || '';
        this.writeDecisionTextFile(project, decision);
        changed = true;
      }
    }
    for (const entry of this.state.auditLogs.filter((item) => item.projectId === project.id)) {
      if (!entry.textPath) {
        entry.textPath = createRecordPath('audit', `${entry.createdAt || ''}-${entry.toolName || 'tool-call'}`, entry.id);
        changed = true;
      }
      const filePath = this.getRecordFilePath(project, entry.textPath);
      if (existsSync(filePath)) {
        this.hydrateAuditText(project, entry);
      } else {
        entry.argsSummary = entry.argsSummary || '';
        entry.resultSummary = entry.resultSummary || '';
        entry.error = entry.error || null;
        this.writeAuditTextFile(project, entry);
        changed = true;
      }
    }
    return changed;
  }

  hydrateTaskText(project, task) {
    task.textPath = task.textPath || createRecordPath('tasks', task.title, task.id);
    const filePath = this.getRecordFilePath(project, task.textPath);
    if (!existsSync(filePath)) {
      task.designIntent = task.designIntent || '';
      task.implementationNotes = task.implementationNotes || '';
      task.acceptanceCriteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
      task.reviewNote = task.reviewNote || '';
      return;
    }
    const sections = parseMarkdownSections(readFileSync(filePath, 'utf8'));
    task.designIntent = sections.get('design intent') ?? task.designIntent ?? '';
    task.implementationNotes = sections.get('implementation notes') ?? task.implementationNotes ?? '';
    task.acceptanceCriteria = parseBulletList(sections.get('acceptance criteria') ?? '', task.acceptanceCriteria);
    task.reviewNote = sections.get('review note') ?? task.reviewNote ?? '';
  }

  hydrateMessageText(project, message) {
    message.textPath = message.textPath || createRecordPath('messages', `${message.createdAt || ''}-${message.from || 'message'}`, message.id);
    const filePath = this.getRecordFilePath(project, message.textPath);
    if (!existsSync(filePath)) {
      message.content = message.content || '';
      return;
    }
    const sections = parseMarkdownSections(readFileSync(filePath, 'utf8'));
    message.content = sections.get('content') ?? message.content ?? '';
  }

  hydrateDecisionText(project, decision) {
    decision.textPath = decision.textPath || createRecordPath('decisions', decision.title, decision.id);
    const filePath = this.getRecordFilePath(project, decision.textPath);
    if (!existsSync(filePath)) {
      decision.rationale = decision.rationale || '';
      decision.consequences = decision.consequences || '';
      return;
    }
    const sections = parseMarkdownSections(readFileSync(filePath, 'utf8'));
    decision.rationale = sections.get('rationale') ?? decision.rationale ?? '';
    decision.consequences = sections.get('consequences') ?? decision.consequences ?? '';
  }

  hydrateAuditText(project, entry) {
    entry.textPath = entry.textPath || createRecordPath('audit', `${entry.createdAt || ''}-${entry.toolName || 'tool-call'}`, entry.id);
    const filePath = this.getRecordFilePath(project, entry.textPath);
    if (!existsSync(filePath)) {
      entry.argsSummary = entry.argsSummary || '';
      entry.resultSummary = entry.resultSummary || '';
      entry.error = entry.error || null;
      return;
    }
    const sections = parseMarkdownSections(readFileSync(filePath, 'utf8'));
    entry.argsSummary = sections.get('arguments summary') ?? entry.argsSummary ?? '';
    entry.resultSummary = sections.get('result summary') ?? entry.resultSummary ?? '';
    const error = sections.get('error');
    entry.error = error ? error : null;
  }

  writeTaskTextFile(project, task) {
    task.textPath = task.textPath || createRecordPath('tasks', task.title, task.id);
    writeFileEnsured(this.getRecordFilePath(project, task.textPath), renderTaskMarkdown(task));
  }

  writeMessageTextFile(project, message) {
    message.textPath = message.textPath || createRecordPath('messages', `${message.createdAt || ''}-${message.from || 'message'}`, message.id);
    writeFileEnsured(this.getRecordFilePath(project, message.textPath), renderMessageMarkdown(message));
  }

  writeDecisionTextFile(project, decision) {
    decision.textPath = decision.textPath || createRecordPath('decisions', decision.title, decision.id);
    writeFileEnsured(this.getRecordFilePath(project, decision.textPath), renderDecisionMarkdown(decision));
  }

  writeAuditTextFile(project, entry) {
    entry.textPath = entry.textPath || createRecordPath('audit', `${entry.createdAt || ''}-${entry.toolName || 'tool-call'}`, entry.id);
    writeFileEnsured(this.getRecordFilePath(project, entry.textPath), renderAuditMarkdown(entry));
  }

  moveProjectDocuments(projectId, previousRoot, nextRoot) {
    mkdirSync(nextRoot, { recursive: true });
    for (const doc of this.state.documents.filter((item) => item.projectId === projectId)) {
      const docPath = normalizeMarkdownPath(doc.path);
      const from = resolveWithinRoot(previousRoot, docPath);
      const to = resolveWithinRoot(nextRoot, docPath);
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    const previousDataRoot = resolve(previousRoot, 'devhub-data');
    const nextDataRoot = resolve(nextRoot, 'devhub-data');
    if (existsSync(previousDataRoot) && !existsSync(nextDataRoot)) {
      mkdirSync(dirname(nextDataRoot), { recursive: true });
      renameSync(previousDataRoot, nextDataRoot);
    }
  }

  getProjectDocsRoot(project) {
    const configured = String(project.docsPath || '').trim();
    if (!configured) return resolve(this.projectSpacePath, project.id, 'docs');
    return isAbsolute(configured) ? resolve(configured) : resolve(this.projectSpacePath, configured);
  }

  getDocumentFilePath(project, path) {
    return resolveWithinRoot(this.getProjectDocsRoot(project), normalizeMarkdownPath(path));
  }

  getProjectDataRoot(project) {
    return resolve(this.getProjectDocsRoot(project), 'devhub-data');
  }

  getRecordFilePath(project, path) {
    return resolveWithinRoot(this.getProjectDataRoot(project), normalizeMarkdownPath(path));
  }

  getObsidianVaultRoot(project) {
    const configured = String(project.obsidianVaultPath || '').trim();
    if (!configured) throw new Error(`Obsidian vault path is not configured for project ${project.id}.`);
    const vaultRoot = isAbsolute(configured) ? resolve(configured) : resolve(this.projectSpacePath, configured);
    mkdirSync(vaultRoot, { recursive: true });
    return vaultRoot;
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
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project;
}

function requireTask(state, projectId, taskId) {
  const task = state.tasks.find((item) => item.projectId === projectId && item.id === taskId);
  if (!task) throw new Error(`Parent task not found: ${taskId}`);
  return task;
}

function isDescendantTask(state, projectId, candidateTaskId, ancestorTaskId) {
  let current = state.tasks.find((task) => task.projectId === projectId && task.id === candidateTaskId);
  while (current?.parentTaskId) {
    if (current.parentTaskId === ancestorTaskId) return true;
    current = state.tasks.find((task) => task.projectId === projectId && task.id === current.parentTaskId);
  }
  return false;
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

function normalizeMarkdownPath(input) {
  const raw = String(input || '').replaceAll('\\', '/').trim();
  if (!raw) throw new Error('Markdown path is required.');
  if (isAbsolute(raw) || raw.startsWith('/') || raw.includes('\0')) {
    throw new Error('Markdown path must be relative.');
  }
  const normalized = raw.split('/').filter(Boolean).join('/');
  const parts = normalized.split('/');
  if (!normalized || parts.includes('..') || parts.includes('.')) {
    throw new Error('Markdown path cannot contain parent directory segments.');
  }
  if (extname(normalized).toLowerCase() !== '.md') {
    throw new Error('Markdown path must end in .md.');
  }
  return normalized;
}

function resolveWithinRoot(root, relativePath) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, normalizeMarkdownPath(relativePath));
  const rel = relative(rootPath, target);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error('Path escapes configured root.');
  }
  return target;
}

function listMarkdownFiles(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.obsidian' || entry.name === 'devhub-data' || entry.name === 'node_modules') continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        found.push(relative(root, fullPath).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function titleFromMarkdownPath(path) {
  return basename(path, '.md')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\s+/g, ' ')
    .trim() || path;
}

function createRecordPath(type, label, recordId) {
  const slug = sanitizePathSegment(String(label || type).toLowerCase()).replaceAll('.', '-').slice(0, 60) || type;
  return `${type}/${slug}-${recordId}.md`;
}

function writeFileEnsured(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function renderTaskMarkdown(task) {
  return [
    `# ${task.title || task.id}`,
    '',
    `Task ID: ${task.id}`,
    `Status: ${task.status || ''}`,
    `Assigned To: ${task.assignedTo || ''}`,
    '',
    '## Design Intent',
    task.designIntent || '',
    '',
    '## Implementation Notes',
    task.implementationNotes || '',
    '',
    '## Acceptance Criteria',
    renderBulletList(task.acceptanceCriteria),
    '',
    '## Review Note',
    task.reviewNote || '',
    '',
  ].join('\n');
}

function renderMessageMarkdown(message) {
  return [
    `# Message ${message.id}`,
    '',
    `Message ID: ${message.id}`,
    `From: ${message.from || ''}`,
    `Task ID: ${message.taskId || ''}`,
    `Created: ${message.createdAt || ''}`,
    '',
    '## Content',
    message.content || '',
    '',
  ].join('\n');
}

function renderDecisionMarkdown(decision) {
  return [
    `# ${decision.title || decision.id}`,
    '',
    `Decision ID: ${decision.id}`,
    `Created By: ${decision.createdBy || ''}`,
    `Created: ${decision.createdAt || ''}`,
    '',
    '## Rationale',
    decision.rationale || '',
    '',
    '## Consequences',
    decision.consequences || '',
    '',
  ].join('\n');
}

function renderAuditMarkdown(entry) {
  return [
    `# Tool Call: ${entry.toolName || entry.id}`,
    '',
    `Audit ID: ${entry.id}`,
    `Role: ${entry.role || ''}`,
    `Upstream ID: ${entry.upstreamId || ''}`,
    `Allowed: ${Boolean(entry.allowed)}`,
    `Created: ${entry.createdAt || ''}`,
    '',
    '## Arguments Summary',
    entry.argsSummary || '',
    '',
    '## Result Summary',
    entry.resultSummary || '',
    '',
    '## Error',
    entry.error || '',
    '',
  ].join('\n');
}

function renderBulletList(items = []) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((item) => `- ${String(item).replace(/\r?\n/g, ' ')}`).join('\n');
}

function parseMarkdownSections(markdown) {
  const sections = new Map();
  const lines = String(markdown || '').split(/\r?\n/);
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current) return;
    sections.set(current, trimSection(buffer.join('\n')));
  };
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = match[1].trim().toLowerCase();
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function parseBulletList(text, fallback = []) {
  const items = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  if (items.length > 0) return items;
  return Array.isArray(fallback) ? fallback : [];
}

function trimSection(text) {
  return String(text || '').replace(/^\s+/, '').replace(/\s+$/, '');
}
