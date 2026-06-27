# Game Dev Hub

A local-first **role-aware MCP gateway** and project workspace for Unity game development with ChatGPT and Codex.

The intended workflow:

```text
ChatGPT ─┐
         ├── Game Dev Hub MCP ─── project docs / tasks / messages / audit logs
Codex  ──┘              │
                        └── upstream Unity MCP adapter
                              └── AnkleBreaker MCP today
                              └── any other Unity MCP later
```

## What this MVP includes

- One local web app for projects, docs, tasks, messages, upstream config, and audit logs.
- `/mcp/chat` endpoint for ChatGPT-style planning and read-only Unity access.
- `/mcp/codex` endpoint for Codex-style implementation and policy-controlled Unity MCP passthrough.
- MCP-agnostic upstream configuration for `streamable_http` and basic `stdio` MCP servers.
- Tool classification by policy patterns and per-tool overrides.
- Audit log for every upstream tool list/call attempt.
- File-backed project documents: Markdown lives in configurable folders, while JSON keeps the small index/config.

This is intentionally dependency-light: it uses Node's built-in HTTP server and `fetch`.

## Requirements

- Node.js 20+
- A Unity MCP server, such as AnkleBreaker, running separately if you want Unity passthrough.

## Run

```bash
cp .env.example .env
# optional: edit .env
npm start
```

Open:

```text
http://localhost:4317
```

## Multiple projects

The web UI can keep multiple projects in the same Dev Hub state file. Use the **Projects** card to:

1. Create a project with its repository and Unity project paths.
2. Switch the active project from the project selector.
3. Choose that project's active upstream MCP server.
4. Maintain separate documents, tasks, messages, upstream configurations, and audit history.

New projects receive their own `AGENTS.md`, `GAME_DESIGN.md`, and `TECHNICAL_DESIGN.md` starter documents. MCP callers can pass `projectId` explicitly or use `project_set_active` to change the default project.

The interface is divided into tabs for project configuration, upstream MCP setup, documents, tasks, activity, and client connection snippets. Tasks support parent/subtask organization, human completion and change-request review actions, and active/archived views. Field labels include contextual help, and detected upstream tools appear in a scrollable collapsed catalog so large MCP servers remain manageable.

## Markdown storage and Obsidian

Dev Hub stores persistent text as real Markdown files. `data/state.json` remains the lightweight database for project metadata, task status, relationships, upstream settings, audit indexes, and file paths, but document bodies, task notes, messages, decisions, and audit summaries are written to `.md` files.

By default, project documents live under:

```text
data/projects/<projectId>/docs
```

Set `DEVHUB_PROJECT_SPACE` to change the default project-space root, or set **DevHub docs path** per project in the web UI. A relative docs path resolves inside the Dev Hub project space; an absolute path can point at a folder inside a game repo so docs can be version controlled with that project.

Dev Hub's own structured record text lives under the configured docs folder:

```text
devhub-data/tasks
devhub-data/messages
devhub-data/decisions
devhub-data/audit
```

These backing files are intentionally separate from `docs_list` documents, so MCP callers keep using the same `tasks_*`, `messages_*`, `decision_*`, and `audit_*` tools without seeing duplicate document entries.

Each project can also configure an **Obsidian vault path**. Vault notes are read and written through separate `vault_*` tools so human-readable Obsidian context stays separate from Dev Hub's own project-document store.

## MCP endpoints

```text
ChatGPT/read role: http://localhost:4317/mcp/chat
Codex/write role:  http://localhost:4317/mcp/codex
Admin role:        http://localhost:4317/mcp/admin
```

By default in local dev, role-specific paths work without bearer tokens unless you set custom token environment variables. For a real setup, set tokens:

```bash
export DEVHUB_CHAT_TOKEN='change-me-chat'
export DEVHUB_CODEX_TOKEN='change-me-codex'
export DEVHUB_ADMIN_TOKEN='change-me-admin'
```

Then clients should send:

```text
Authorization: Bearer <token>
```

## Codex config

Put this in your Unity repo at `.codex/config.toml`:

```toml
[mcp_servers.game_dev_hub]
url = "http://localhost:4317/mcp/codex"
bearer_token_env_var = "DEVHUB_CODEX_TOKEN"
tool_timeout_sec = 120
enabled = true
```

Then:

```bash
export DEVHUB_CODEX_TOKEN='dev-codex-token'
```

If you set a custom token on the server, use the same value here.

## ChatGPT connector

For local testing with ChatGPT connectors, expose this endpoint through a secure tunnel:

```text
https://your-tunnel-url/mcp/chat
```

Use the ChatGPT token:

```text
DEVHUB_CHAT_TOKEN
```

Recommended: only expose the Dev Hub endpoint, not the raw Unity MCP endpoint.

## Configure AnkleBreaker or another Unity MCP

In the web UI:

1. Open **Upstream Unity MCP Servers**.
2. Load or create an upstream.
3. Set transport to `streamable_http`.
4. Set URL to your upstream MCP endpoint, for example:

```text
http://localhost:8080/mcp
```

5. Enable it.
6. Keep **ChatGPT full Unity access** off for read-only planning/review. Turn it on only when you want ChatGPT to call write or destructive-classified Unity MCP tools through this upstream. Explicit per-tool `deny` overrides still block calls.
7. For a `stdio` upstream, optionally set environment variables as a JSON object:

```json
{
  "UNITY_PORT": "8080",
  "LOG_LEVEL": "debug"
}
```

These values are merged over the Game Dev Hub process environment when the upstream server starts.

8. Configure semantic tools if you want ChatGPT convenience wrappers:

```json
{
  "sceneOverview": "your_scene_overview_tool_name",
  "consoleRead": "your_console_tool_name",
  "screenshot": "your_screenshot_tool_name",
  "assetSearch": "your_asset_search_tool_name",
  "testResults": "your_test_results_tool_name"
}
```

Use **Save, Connect & List Tools** to verify the upstream connection and fetch its live `tools/list` catalog. The UI shows:

- The regex-derived category and matching pattern for every tool.
- The effective category after any manual override.
- Category-specific card colors and filtering for read, write, destructive, denied, and uncategorized tools.
- Chat and Codex access behavior.
- The tool description and input schema.

Choose **Auto (profile / regex)**, **Read**, **Write**, **Destructive**, or **Deny** for each discovered tool, then save the overrides. Explicitly denied tools are blocked for both ChatGPT and Codex.

When the live catalog matches AnkleBreaker Unity MCP's documented two-tier signature, Dev Hub automatically enables the `anklebreaker-unity` profile. It classifies documented observation actions as read, mutations as write, deletion/removal and arbitrary execution surfaces as destructive, and dynamically classifies the nested tool passed through `unity_advanced_tool`. Exact manual overrides still take precedence.

Because Unity MCP servers vary in tool names, this hub does not hardcode AnkleBreaker-specific tool names. Use `upstream_tool_catalog` to discover tool names, then add semantic mappings or policy overrides.

## Important tools

Both ChatGPT and Codex can use:

- `project_list`
- `project_get`
- `docs_list`
- `docs_read`
- `docs_write`
- `docs_search`
- `vault_list`
- `vault_read`
- `vault_write`
- `vault_search`
- `tasks_list`
- `task_read`
- `task_create`
- `task_update`
- `task_delete`
- `messages_list`
- `message_post`
- `decision_record`
- `upstreams_list`
- `upstream_tool_catalog`
- `audit_list`

ChatGPT gets read-oriented Unity tools:

- `unity_call_read_tool`
- `unity_scene_overview`
- `unity_console_read`
- `unity_screenshot`

Codex gets implementation-oriented Unity passthrough:

- `unity_call_tool`

## Policy model

Each upstream has a `policy` object:

```json
{
  "chatFullAccess": false,
  "defaultForChat": "deny",
  "defaultForCodex": "allow",
  "readPatterns": ["get_*", "list_*", "find_*", "inspect_*", "read_*", "*screenshot*", "*console*"],
  "writePatterns": ["create_*", "set_*", "update_*", "delete_*", "run_*", "build_*"],
  "destructivePatterns": ["delete_*", "remove_*", "*destroy*"],
  "overrides": {
    "capture_screenshot": "read",
    "create_game_object": "write",
    "delete_game_object": "destructive"
  },
  "codexRequiresConfirmationCategories": ["destructive"]
}
```

Chat role can only call tools classified as `read`.

If an upstream policy sets `"chatFullAccess": true`, ChatGPT can call write and destructive-classified upstream tools unless a tool is explicitly denied. This is off by default and can be toggled in the Upstream MCP tab.

Codex role can call allowed tools. Destructive tools are blocked unless Codex passes:

```json
{
  "confirm": true
}
```

## Example MCP call

List tools:

```bash
curl -s http://localhost:4317/mcp/codex \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-codex-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Create a task:

```bash
curl -s http://localhost:4317/mcp/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-chat-token' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_create","arguments":{"title":"Add Sothis Eclipse Dash Follow-Up","status":"ready_for_codex","assignedTo":"codex","designIntent":"Make Sothis chain mobility into burst damage.","acceptanceCriteria":["Dash still works without follow-up","Follow-up cannot be spammed","No new healing sources"]}}}'
```

## Smoke test

```bash
npm start
# in another shell
node scripts/smoke-test.js
```

## Next recommended improvements

- Add optional SQLite migrations for larger task/audit datasets.
- Add vector search over docs/playtest notes.
- Add OAuth for public ChatGPT connector exposure.
- Add approval queue in UI for destructive Codex calls.
- Add first-class direct passthrough tool surfacing instead of only `unity_call_tool`.
- Add repo/Git integration: branch creation, diff summaries, commit notes.
