import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
