import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/storage.js';

test('projects keep independent configuration, documents, and upstreams', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-projects-'));

  try {
    const store = new JsonStore(join(directory, 'state.json'));
    store.load();
    const firstProjectId = store.getState().activeProjectId;
    const secondProject = store.createProject({
      name: 'Second Game',
      repoPath: 'D:/Games/Second',
      unityProjectPath: 'D:/Games/Second/Unity',
    });

    assert.deepEqual(
      store.listDocuments(secondProject.id).map((document) => document.path).sort(),
      ['AGENTS.md', 'GAME_DESIGN.md', 'TECHNICAL_DESIGN.md'],
    );

    store.writeDocument(firstProjectId, {
      path: 'ONLY_FIRST.md',
      content: 'First project only',
    });
    store.writeDocument(secondProject.id, {
      path: 'ONLY_SECOND.md',
      content: 'Second project only',
    });

    const upstream = store.upsertUpstream(secondProject.id, {
      id: 'second-mcp',
      name: 'Second MCP',
      transport: 'stdio',
      command: 'second-server',
      env: { SECOND_PROJECT: true },
    });
    store.updateProject(secondProject.id, { activeUpstreamId: upstream.id });
    store.setActiveProject(secondProject.id);

    assert.equal(store.getState().activeProjectId, secondProject.id);
    assert.equal(store.getProject(secondProject.id).repoPath, 'D:/Games/Second');
    assert.equal(store.getProject(secondProject.id).activeUpstreamId, 'second-mcp');
    assert.equal(store.listUpstreams(firstProjectId).some((item) => item.id === 'second-mcp'), false);
    assert.equal(store.getDocument(firstProjectId, 'ONLY_SECOND.md'), null);
    assert.equal(store.getDocument(secondProject.id, 'ONLY_FIRST.md'), null);
    assert.throws(
      () => store.updateProject(firstProjectId, { activeUpstreamId: 'second-mcp' }),
      /Upstream not found for project/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project documents are stored as markdown files and indexed in json', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-file-docs-'));
  const statePath = join(directory, 'state.json');
  const projectSpacePath = join(directory, 'workspace');

  try {
    const store = new JsonStore(statePath, { projectSpacePath });
    store.load();
    const projectId = store.getState().activeProjectId;

    const doc = store.writeDocument(projectId, {
      path: 'TASKS/example-task.md',
      title: 'Example Task',
      kind: 'task',
      content: '# Example Task\n\nShip it.',
    });

    const filePath = join(projectSpacePath, projectId, 'docs', 'TASKS', 'example-task.md');
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, 'utf8'), doc.content);

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    const indexed = persisted.documents.find((item) => item.path === 'TASKS/example-task.md');
    assert.equal(indexed.storage, 'file');
    assert.equal(indexed.source, 'project');
    assert.equal(Object.hasOwn(indexed, 'content'), false);

    writeFileSync(join(projectSpacePath, projectId, 'docs', 'EXTERNAL.md'), '# External\n\nCreated outside DevHub.');
    assert.equal(store.getDocument(projectId, 'EXTERNAL.md').content.includes('outside DevHub'), true);
    assert.throws(
      () => store.writeDocument(projectId, { path: '../escape.md', content: 'nope' }),
      /relative|parent directory/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('obsidian vault notes are stored separately from devhub project documents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-vault-'));
  const statePath = join(directory, 'state.json');
  const vaultPath = join(directory, 'obsidian');

  try {
    const store = new JsonStore(statePath, { projectSpacePath: join(directory, 'workspace') });
    store.load();
    const projectId = store.getState().activeProjectId;
    store.updateProject(projectId, { obsidianVaultPath: vaultPath });

    const note = store.writeVaultNote(projectId, {
      path: 'Context/flare.md',
      content: '# Flare Context\n\nReadable by agents and humans.',
    });

    assert.equal(note.source, 'obsidian');
    assert.equal(existsSync(join(vaultPath, 'Context', 'flare.md')), true);
    assert.equal(store.listDocuments(projectId).some((document) => document.path === 'Context/flare.md'), false);
    assert.equal(store.searchVaultNotes(projectId, 'agents')[0].path, 'Context/flare.md');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tasks messages decisions and audit text are backed by markdown files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-record-docs-'));
  const statePath = join(directory, 'state.json');
  const projectSpacePath = join(directory, 'workspace');

  try {
    const store = new JsonStore(statePath, { projectSpacePath });
    store.load();
    const projectId = store.getState().activeProjectId;

    const task = store.createTask(projectId, {
      title: 'Markdown backed task',
      status: 'ready_for_codex',
      designIntent: 'Keep task intent in a readable file.',
      implementationNotes: 'Touch the storage layer only.',
      acceptanceCriteria: ['Task text is file-backed', 'MCP shape stays unchanged'],
      assignedTo: 'codex',
    });
    const message = store.postMessage(projectId, {
      from: 'chatgpt',
      taskId: task.id,
      content: 'This message should live in markdown.',
    });
    const decision = store.recordDecision(projectId, {
      title: 'Use markdown records',
      rationale: 'Humans can review persistent text in Git.',
      consequences: 'JSON stays small.',
    });
    const audit = store.logToolCall({
      projectId,
      role: 'codex',
      toolName: 'example_tool',
      argsSummary: '{"ok":true}',
      resultSummary: 'Tool call succeeded.',
      allowed: true,
    });

    const taskFile = join(projectSpacePath, projectId, 'docs', 'devhub-data', task.textPath);
    const messageFile = join(projectSpacePath, projectId, 'docs', 'devhub-data', message.textPath);
    const decisionFile = join(projectSpacePath, projectId, 'docs', 'devhub-data', decision.textPath);
    const auditFile = join(projectSpacePath, projectId, 'docs', 'devhub-data', audit.textPath);

    assert.equal(existsSync(taskFile), true);
    assert.equal(existsSync(messageFile), true);
    assert.equal(existsSync(decisionFile), true);
    assert.equal(existsSync(auditFile), true);

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    const persistedTask = persisted.tasks.find((item) => item.id === task.id);
    const persistedMessage = persisted.messages.find((item) => item.id === message.id);
    const persistedDecision = persisted.decisions.find((item) => item.id === decision.id);
    const persistedAudit = persisted.auditLogs.find((item) => item.id === audit.id);
    assert.equal(Object.hasOwn(persistedTask, 'designIntent'), false);
    assert.equal(Object.hasOwn(persistedTask, 'acceptanceCriteria'), false);
    assert.equal(Object.hasOwn(persistedMessage, 'content'), false);
    assert.equal(Object.hasOwn(persistedDecision, 'rationale'), false);
    assert.equal(Object.hasOwn(persistedAudit, 'resultSummary'), false);

    const reloaded = new JsonStore(statePath, { projectSpacePath });
    reloaded.load();
    assert.equal(reloaded.getTask(projectId, task.id).designIntent, 'Keep task intent in a readable file.');
    assert.deepEqual(reloaded.getTask(projectId, task.id).acceptanceCriteria, ['Task text is file-backed', 'MCP shape stays unchanged']);
    assert.equal(reloaded.listMessages(projectId, task.id)[0].content, 'This message should live in markdown.');
    assert.equal(reloaded.listDecisions(projectId)[0].rationale, 'Humans can review persistent text in Git.');
    assert.equal(reloaded.listAuditLogs(projectId, 1)[0].resultSummary, 'Tool call succeeded.');

    writeFileSync(taskFile, readFileSync(taskFile, 'utf8').replace('Keep task intent in a readable file.', 'Edited from the markdown file.'));
    assert.equal(reloaded.getTask(projectId, task.id).designIntent, 'Edited from the markdown file.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tasks support review state, archive filtering, hierarchy, and delete', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-tasks-'));

  try {
    const store = new JsonStore(join(directory, 'state.json'));
    store.load();
    const projectId = store.getState().activeProjectId;

    const parent = store.createTask(projectId, {
      title: 'Build phased combat feature',
      status: 'ready_for_codex',
      assignedTo: 'codex',
    });
    const child = store.createTask(projectId, {
      title: 'Phase 1 movement lockout',
      parentTaskId: parent.id,
      status: 'idea',
    });

    assert.equal(store.getTask(projectId, child.id).parentTaskId, parent.id);
    assert.throws(
      () => store.updateTask(projectId, parent.id, { parentTaskId: child.id }),
      /subtasks/,
    );

    const changeRequest = store.updateTask(projectId, child.id, {
      requestChanges: true,
      reviewNote: 'Tighten the acceptance criteria.',
      changesRequestedBy: 'human',
    });
    assert.equal(changeRequest.status, 'changes_requested');
    assert.equal(changeRequest.reviewNote, 'Tighten the acceptance criteria.');
    assert.equal(changeRequest.changesRequestedBy, 'human');

    const complete = store.updateTask(projectId, child.id, {
      status: 'complete',
      completedBy: 'human',
    });
    assert.equal(complete.status, 'complete');
    assert.equal(complete.completedBy, 'human');
    assert.ok(complete.completedAt);

    store.updateTask(projectId, child.id, { archive: true, archivedBy: 'human' });
    assert.equal(store.listTasks(projectId).some((task) => task.id === child.id), false);
    assert.equal(store.listTasks(projectId, { archivedOnly: true }).some((task) => task.id === child.id), true);
    assert.equal(store.listTasks(projectId, { includeArchived: true }).some((task) => task.id === child.id), true);

    store.updateTask(projectId, child.id, { archive: false });
    store.deleteTask(projectId, parent.id);
    assert.equal(store.getTask(projectId, parent.id), null);
    assert.equal(store.getTask(projectId, child.id).parentTaskId, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
