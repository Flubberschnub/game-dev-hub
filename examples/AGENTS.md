# AGENTS.md

## Roles

ChatGPT is the architect, designer, planner, and reviewer.
Codex is the implementer, refactorer, test runner, and Unity editor operator.

## Workflow

1. ChatGPT creates tasks with `status=ready_for_codex`.
2. Codex reads the task, implements the smallest useful change, and uses Unity MCP for inspection and verification.
3. Codex posts a result message and sets the task to `codex_done`.
4. ChatGPT reviews and either creates follow-up tasks or records acceptance.

## Unity Rules

- Prefer Unity MCP/editor operations for scene, prefab, and serialized asset changes.
- Prefer direct repo edits for code.
- Check compilation after code changes.
- Run focused EditMode or PlayMode tests when available.
- Avoid unrelated scene/prefab changes.

## Code Rules

- Keep gameplay systems modular and event-driven.
- Do not add packages without explicit approval.
- Do not rewrite broad systems for a small gameplay task.
