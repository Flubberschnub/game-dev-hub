import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effectiveToolCategory,
  filterToolCatalog,
  toolCategoryLabel,
} from '../public/toolCatalog.js';

const tools = [
  { name: 'read_scene', policy: { regexCategory: 'read', override: null } },
  { name: 'set_scene', policy: { regexCategory: 'write', override: null } },
  { name: 'delete_scene', policy: { regexCategory: 'destructive', override: 'deny' } },
  { name: 'custom_tool', policy: { regexCategory: 'unknown', override: null } },
];

test('tool catalog uses effective override categories', () => {
  assert.equal(effectiveToolCategory(tools[2]), 'deny');
  assert.equal(effectiveToolCategory({ policy: { automaticCategory: 'read', regexCategory: 'unknown' } }), 'read');
  assert.equal(effectiveToolCategory({ policy: { regexCategory: 'unexpected' } }), 'unknown');
});

test('tool catalog filters categories including uncategorized', () => {
  assert.deepEqual(
    filterToolCatalog(tools, 'write').map(({ tool }) => tool.name),
    ['set_scene'],
  );
  assert.deepEqual(
    filterToolCatalog(tools, 'unknown').map(({ tool }) => tool.name),
    ['custom_tool'],
  );
  assert.equal(filterToolCatalog(tools, 'all').length, tools.length);
  assert.equal(toolCategoryLabel('unknown'), 'Uncategorized');
  assert.equal(toolCategoryLabel('deny'), 'Denied');
});
