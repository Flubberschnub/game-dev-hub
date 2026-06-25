import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectToolPolicy, isAllowed } from '../src/policy.js';
import { detectToolProfile } from '../src/toolProfiles.js';

test('policy inspector reports regex matches and manual overrides', () => {
  const policy = {
    readPatterns: ['get_*'],
    writePatterns: ['set_*', 'delete_*'],
    destructivePatterns: ['delete_*'],
    overrides: {
      set_material: 'read',
      get_secret: 'deny',
    },
  };

  const deletePolicy = inspectToolPolicy('delete_asset', policy);
  assert.equal(deletePolicy.category, 'destructive');
  assert.equal(deletePolicy.regexCategory, 'destructive');
  assert.equal(deletePolicy.matchedPattern, 'delete_*');
  assert.equal(deletePolicy.override, null);

  const setPolicy = inspectToolPolicy('set_material', policy);
  assert.equal(setPolicy.category, 'read');
  assert.equal(setPolicy.regexCategory, 'write');
  assert.equal(setPolicy.matchedPattern, 'set_*');
  assert.equal(setPolicy.override, 'read');
  assert.equal(inspectToolPolicy('unmatched_tool', policy).regexCategory, 'unknown');
});

test('AnkleBreaker profile classifies documented core and advanced actions', () => {
  const policy = { toolProfile: 'anklebreaker-unity', overrides: {} };

  assert.equal(inspectToolPolicy('unity_scene_hierarchy', policy).category, 'read');
  assert.equal(inspectToolPolicy('unity_asset_list', policy).category, 'read');
  assert.equal(inspectToolPolicy('unity_console_clear', policy).category, 'write');
  assert.equal(inspectToolPolicy('unity_scene_save', policy).category, 'write');
  assert.equal(inspectToolPolicy('unity_gameobject_delete', policy).category, 'destructive');
  assert.equal(inspectToolPolicy('unity_execute_code', policy).category, 'destructive');

  assert.equal(
    inspectToolPolicy('unity_advanced_tool', policy, { tool: 'unity_terrain_list' }).category,
    'read',
  );
  assert.equal(
    inspectToolPolicy('unity_advanced_tool', policy, { tool: 'unity_playerprefs_delete_all' }).category,
    'destructive',
  );
});

test('AnkleBreaker advanced proxy honors nested exact overrides', () => {
  const upstream = {
    policy: {
      toolProfile: 'anklebreaker-unity',
      overrides: { unity_terrain_list: 'deny' },
    },
  };

  const result = isAllowed({
    role: 'codex',
    toolName: 'unity_advanced_tool',
    upstream,
    arguments: { tool: 'unity_terrain_list' },
  });
  assert.equal(result.category, 'deny');
  assert.equal(result.allowed, false);
});

test('AnkleBreaker profile is detected from its documented two-tier signature', () => {
  assert.equal(detectToolProfile([
    { name: 'unity_list_instances' },
    { name: 'unity_list_advanced_tools' },
    { name: 'unity_advanced_tool' },
    { name: 'unity_get_project_context' },
  ]), 'anklebreaker-unity');
  assert.equal(detectToolProfile([{ name: 'unity_scene_info' }]), null);
});

test('deny overrides block chat, codex, and confirmed destructive calls', () => {
  const upstream = {
    policy: {
      overrides: {
        delete_everything: 'deny',
      },
    },
  };

  assert.equal(isAllowed({ role: 'chat', toolName: 'delete_everything', upstream }).allowed, false);
  assert.equal(isAllowed({ role: 'codex', toolName: 'delete_everything', upstream }).allowed, false);
  assert.equal(
    isAllowed({ role: 'codex', toolName: 'delete_everything', upstream, confirm: true }).allowed,
    false,
  );
});
