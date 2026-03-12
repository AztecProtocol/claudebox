## Environment

- **Working directory**: `/workspace/aztec-packages` — the repo is **pre-cloned** from `origin/next` (or the base branch) at container start.
- On resume sessions the repo persists from the previous run — no need to re-clone.
- Use `clone_repo` only if you need to re-checkout a different ref or update submodules. It's safe to call repeatedly.
- Remote: `https://github.com/AztecProtocol/aztec-packages.git`
- Full internet access for packages, builds, etc.
- Use `/tmp` for scratch files

## Git Authentication

**IMPORTANT**: The container has NO direct git credentials. `git fetch` and `git pull` will fail for private repos or authenticated operations.

Use the MCP proxy tools instead:
- **`git_fetch`** — fetch refs from origin (supports `--depth`, refspecs, etc.)
- **`git_pull`** — pull from origin (supports `--rebase`, `--ff-only`, etc.)
- **`submodule_update`** — initialize and update submodules (optionally to a specific commit)

These tools handle authentication through the sidecar. Use them instead of bare `git fetch`/`git pull`.

**Submodules are NOT initialized by default.** If your task requires submodules (e.g. building projects that depend on `noir/noir-repo`), use `submodule_update` to init them.

## Checking out other branches

- **PR review/fix** (e.g. `#12345`):
  ```
  git_fetch(args="origin pull/12345/head:pr-12345")
  git checkout pr-12345
  ```
- **Branch work**:
  ```
  git_fetch(args="origin <branch>")
  git checkout origin/<branch>
  ```

## CI Logs

**IMPORTANT**: Do NOT use `CI_PASSWORD`, curl the CI log server directly, or run `ci.sh dlog` manually. Use the MCP tools instead:

- **`read_log(key="<hash>")`** — read a CI log by key. Supports `head`/`tail` params for large logs.
- **`write_log(content="...", key="my-key")`** — write content to a CI log. Returns a shareable URL.

For CI log URLs, extract the key/hash and pass it to `read_log`.

## Communication — MCP Tools

**IMPORTANT**: You have NO direct GitHub authentication. `gh` CLI, `GH_TOKEN`, and `git push` are NOT available.
All GitHub writes MUST go through dedicated MCP tools. `github_api` is **read-only**.

| Tool | Purpose |
|------|---------|
| `clone_repo` | Clone/update the repo at a given ref. Safe on resume. |
| `git_fetch` | Fetch refs from origin (authenticated). |
| `git_pull` | Pull from origin (authenticated). |
| `submodule_update` | Init/update submodules recursively. |
| `set_workspace_name` | Give this workspace a short descriptive slug. |
| `respond_to_user` | **REQUIRED** — send your final response (Slack + GitHub). |
| `get_context` | Session metadata (user, repo, log_url, thread, etc.) |
| `session_status` | Update Slack + GitHub status message in-place. Call frequently. |
| `github_api` | GitHub REST API proxy — **read-only** (GET only) |
| `slack_api` | Slack API proxy — channel/thread auto-injected |
| `create_pr` | Stage all changes, commit, push, create a **draft** PR (auto-labeled `claudebox`) |
| `update_pr` | Push to / modify existing PRs. Only `claudebox`-labeled PRs. |
| `read_log` | Read a CI log by key/hash. |
| `write_log` | Write content to a CI log — lightweight alternative to create_gist. |
| `create_gist` | Create a gist (one per session, then use update_gist) |
| `update_gist` | Add/update files in an existing gist |
| `ci_failures` | CI status for a PR — failed jobs, pass/fail history, links |
| `aztec_packages_create_issue` | Create a GitHub issue in AztecProtocol/aztec-packages |
| `linear_get_issue` | Fetch a Linear issue by identifier (e.g. `A-453`) |
| `linear_create_issue` | Create a new Linear issue |
| `record_stat` | Record structured data to JSONL (see tool description for schemas) |

### `github_api` — read-only, GET only

Whitelisted paths (all scoped to `repos/AztecProtocol/aztec-packages`):
- `pulls`, `pulls/:id`, `pulls/:id/files`, `pulls/:id/reviews`, `pulls/:id/comments`, `pulls/:id/commits`
- `issues`, `issues/:id`, `issues/:id/timeline`, `issues/:id/events`, `issues/:id/comments`
- `actions/workflows`, `actions/runs`, `actions/runs/:id/jobs`, `actions/jobs/:id/logs`
- `check-runs/:id`, `check-suites/:id/check-runs`, `commits/:sha/status`, `commits/:sha/check-runs`
- `contents/*`, `commits`, `compare/*`, `branches`, `git/ref/*`
- `contributors`, `assignees`, `collaborators`
- `search/issues`, `search/code` (global)
- `gists/:id` (global, read-only)

### `create_pr` — gotchas:
- `create_pr` runs `git add -A` and auto-commits with the PR title. Ensure your working tree is clean of scratch files.
- `.claude/` files are **blocked** by default. Opt in with `include_claude_files=true` if the task requires it.
- `.github/` workflow files are **blocked** unless the session has `ci_allow` (check `get_context`).
- `noir/noir-repo` submodule is **auto-reset** before staging. Pass `include_noir_submodule=true` only if intentional.
- Use `closes` parameter to auto-add "Closes #N" to the PR body.

### `update_pr` — push to existing PRs:
Use `push=true` to push commits — this is the **only way to push** since `git push` has no auth.

### Formatting for GitHub
All `body` and `files` parameters are posted to GitHub as Markdown. Use **real newlines**, not literal `\n`.

## Building

Run builds from `/workspace/aztec-packages` using `make` or per-project `bootstrap.sh`.

**IMPORTANT**: There are no MCP build tools. Use Bash directly. Builds can take a long time — only build what you actually need.

### Makefile targets (preferred, next branch+)

```bash
cd /workspace/aztec-packages
make <target>
```

Aggregate targets:
- `fast` — full default build (barretenberg + boxes + playground + docs + aztec-up + all tests)
- `full` — fast + extra tests + benches
- `release` — fast + cross-compiled binaries

Barretenberg C++:
- `bb-cpp-native` — native build (bb + bb-avm binaries)
- `bb-cpp-wasm` / `bb-cpp-wasm-threads` — WASM builds
- `bb-cpp` — all of: native + wasm + wasm-threads
- `bb-cpp-asan` — address sanitizer build

Barretenberg other: `bb-ts`, `bb-rs`, `bb-sol`, `bb-acir`, `bb-docs`, `bb-crs`, `bb-bbup`

Noir: `noir`, `noir-projects`, `noir-protocol-circuits`, `noir-contracts`, `aztec-nr`

Other: `yarn-project`, `l1-contracts`, `l1-contracts-src`, `playground`, `boxes`, `docs`

### bootstrap.sh fallback (older branches without Makefile)

```bash
cd /workspace/aztec-packages/<project>
./bootstrap.sh [function]
```

Examples: `cd barretenberg/cpp && ./bootstrap.sh build_native`, `cd yarn-project && ./bootstrap.sh`

### C++ cmake targets (faster for single binaries)

```bash
cd /workspace/aztec-packages/barretenberg/cpp
cmake --preset clang20           # configure (once)
cmake --build --preset clang20 --target <target>  # e.g. bb, ultra_honk_tests
```

Presets: `clang20` (default), `clang20-no-avm`, `debug`, `debug-fast`, `asan-fast`

Test binaries land in `build/bin/` — run with `./build/bin/<test> --gtest_filter='*Pattern*'`

### Formatting

- **TypeScript** (yarn-project): `npx prettier --write <files>` from `yarn-project/`
- **C++** (barretenberg): `./format.sh changed` from `barretenberg/cpp/`

Formatting is auto-applied before `create_pr` / `update_pr`.

### Build logs

For long-running commands, capture output and use `write_log` to create a persistent link:
```bash
make yarn-project 2>&1 | tee /tmp/build.log
# Then use write_log MCP tool with the contents
```

## Tips — avoiding common failures

- **Absolute paths**: Always use absolute paths with `Read`, `Glob`, `Grep`.
- **Large files**: Use `offset`+`limit` to read chunks, or `Grep` to find what you need.
- **CI investigation**: Use `ci_failures(pr=12345)` instead of manually calling `github_api`.
- **No `gh` CLI or `git push`**: Use dedicated MCP tools.
- **No direct `git fetch`/`git pull`**: Use the MCP tools — they handle authentication.
- **Git conflicts on resume**: Run `git checkout . && git clean -fd` first.
- **Always use full GitHub URLs**: `https://github.com/AztecProtocol/aztec-packages/pull/123` not `PR #123`.
- **`session_status` edits in place**: Call it often — no spam.

## Rules
- **Call `session_status` after every major step** — the user is watching live.
- End with `respond_to_user` (the user won't see your final text message without it)
- **Never use `gh` CLI, `git push`, or bare `git fetch`/`git pull`** — use MCP tools
- **Git identity**: You are `AztecBot <tech@aztec-labs.com>`. Do NOT add `Co-Authored-By` trailers.
