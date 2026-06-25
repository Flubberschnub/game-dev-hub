import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/storage.js';

test('upstream env is persisted as string environment values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-'));
  const statePath = join(directory, 'state.json');

  try {
    const store = new JsonStore(statePath);
    store.load();
    const projectId = store.getState().activeProjectId;

    const upstream = store.upsertUpstream(projectId, {
      id: 'env-test',
      name: 'Environment Test',
      transport: 'stdio',
      command: 'test-server',
      env: {
        STRING_VALUE: 'hello',
        NUMBER_VALUE: 4317,
        BOOLEAN_VALUE: true,
      },
    });

    assert.deepEqual(upstream.env, {
      STRING_VALUE: 'hello',
      NUMBER_VALUE: '4317',
      BOOLEAN_VALUE: 'true',
    });

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(
      persisted.upstreams.find((item) => item.id === 'env-test').env,
      upstream.env,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('upstream env rejects non-object and nested values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-dev-hub-'));

  try {
    const store = new JsonStore(join(directory, 'state.json'));
    store.load();
    const projectId = store.getState().activeProjectId;
    const base = {
      id: 'invalid-env-test',
      name: 'Invalid Environment Test',
      transport: 'stdio',
      command: 'test-server',
    };

    assert.throws(
      () => store.upsertUpstream(projectId, { ...base, env: [] }),
      /must be a JSON object/,
    );
    assert.throws(
      () => store.upsertUpstream(projectId, { ...base, env: { NESTED: { value: 'nope' } } }),
      /must be a string, number, or boolean/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
