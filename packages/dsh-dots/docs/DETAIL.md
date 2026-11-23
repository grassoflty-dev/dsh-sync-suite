# Config sync (dsh-dots) — details

> English detail page: architecture, data directories, restore flow, risk boundaries, and troubleshooting.
> The Chinese edition is `docs/DETAIL.zh.md`.

## 1. What it solves

Most of DSH's usable configuration lives under `~/.dsh/profiles/<profile>/`: `cordis.patch.yml`
(an entry array that may contain `!!js` expressions and comments), the plugin manifest, MCP
definitions, and provider definitions. Copying those files between machines by hand has three
failure modes:

1. **Secrets leak**: patches often contain `apiKey` / `token` values.
2. **Whole-file copies destroy local content**: comments, local-only entries, and versions differ per machine.
3. **Conflicts cannot be undone**: a bad overwrite has no one-click recovery.

The plugin answers them with "one directory per device + per-entry merge + secret redaction +
pre-write snapshot".

## 2. Architecture

```
┌──────────────────────────── Web GUI (browser) ────────────────────────────┐
│  settings.section / id=dots / order=70                        │
│  src/client.js (plain JS, registered through __ModuleLoader__)            │
│    · form, status badges, preview diffs, snapshot list, inline errors     │
│    · single egress: fetch('/dsh-dots/rpc', {action, ...})      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ same-origin POST, {ok,data} | {ok,error}
┌───────────────────────────────┴──────────────────────────────────────────┐
│  Host process (Cordis plugin, dist/index.js)                              │
│    ctx.webServer.register({kind:'exact', path:'/dsh-dots/rpc'})│
│    ctx.connection.requestRejection(req) → 401/403                        │
│    rpc.ts: action dispatch + serialized write queue + 10 MB body cap     │
│    engine/: collect → preview → apply/rollback (fail-closed)             │
│              git.ts (execFile('git')) · patch.ts (per-entry merge)       │
│              secrets.ts (redact/restore) · pluginMerge.ts (MERGE-only)   │
│              snapshot.ts (pre-write snapshot) · paths.ts (injectable dirs)│
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ system git (HTTPS via temporary GIT_ASKPASS, SSH via ssh-agent)
                    ┌───────────┴────────────┐
                    │ your private repository │
                    │ devices/<deviceId>/...  │
                    └────────────────────────┘
```

Key points:

- **The browser never touches files**; every write happens on the Host side.
- **Same-origin only**: no cross-origin or third-party service call, and the token never reaches browser storage.
- **No runtime npm dependencies**: the Host uses `node:` built-ins plus the system `git`; `dist/` is committed.
- The settings page uses the `settings.section` slot (not `ctx.settings.installSection` / `settings.plugin.item`).

## 3. Data directories

### 3.1 Local (never enters the repository)

```
%USERPROFILE%\.dsh\dots\
  settings.json            # repoUrl/platform/authMode/username/deviceId/branch/scope (no token)
  credentials.json         # { token }, mode 0600, current user only
  work\<repoHash>\         # working copy, repoHash = first 16 hex chars of sha256(repoUrl)
  plugins.to-install.json  # MERGE-only install plan
%USERPROFILE%\.dsh\vet\restore-snapshots\
  <YYYYMMDD-HHmmss>[-n]\
    files\<name>           # copy of a profile file before writing
    manifest.json          # per-file sha256 / bytes
```

Retention: only the latest **10** restore snapshots are kept; `SnapshotStore.prune()` removes the rest.

### 3.2 Remote repository

```
<repo>/
  devices/
    pc-a/
      cordis.patch.yml     # redacted profile patch (comments and !!js preserved)
      providers.json       # { providers: { <id>: definition } }
      plugins.json         # { plugins: [{ name, version, source, enabled }] }
      mcp.json             # { entries: [{ id, text }] }
      manifest.json        # { deviceId, time, scopes, dshVersion, files:[{name,sha256,bytes}] }
    pc-b/ ...
```

Rules: **a device writes only its own directory**; other directories are read for preview only.
`manifest.json` is the snapshot index, and its `sha256` values are transport/write checks, not a
content merge. Device IDs must match `^[a-z0-9][a-z0-9-]{0,31}$`.

## 4. Sync algorithm

### 4.1 Per-entry patch merge (no YAML round-trip)

`cordis.patch.yml` is a top-level YAML array:

```yaml
# file header comment
- id: llm-pi-ai
  config:
    providers: ...
- insert:
    - id: dsh-git-sync
      name: 'dsh-git-sync'
```

- Entry key: a top-level `id:` becomes that id; an `insert:` entry becomes `insert:<first inner id>`;
  anything else becomes `entry:<index>`.
- **`insert:` multi-line block limit (important)**: an entire `insert:` block is one unit keyed by its
  first inner `id`, and merging replaces the whole block. If one block mixes several plugins, the other
  plugins in that block cannot be selected or rolled back independently across devices. Avoid it by
  keeping exactly one row per `insert:` entry, and do not nest an `insert:` inside another one — the
  Loader only reads `insert` at the patch's top level.

  ```yaml
  - insert:
      - id: plugin-a
        name: 'plugin-a'
  - insert:
      - id: plugin-b
        name: 'plugin-b'
  ```

  The plugin never rewrites the profile structure itself (it replaces entry text as a block).
  `preview` shows the complete block text; when a whole-block replacement appears, keep the local
  version or split the block by hand before syncing.
- Merge: local order wins; local-only entries are kept; remote-only entries are appended (with their
  leading comment); same key with different text → `changed` (the remote block text is used);
  identical → `same`; a remote block containing `__SECRET__` and differing from local → `manual`
  (never overwritten automatically).
- Output guarantees: file header/leading comments, `!!js` expressions, indentation, and key order are
  unchanged, with exactly one trailing newline. Comments therefore survive, and `!!js` is never
  parsed and re-serialized.

### 4.2 Secret redaction and restore

- Secret keys are matched on **word boundaries** (not substrings): exact `token` / `secret` /
  `password` / `authorization` / `bearer`, or adjacent `api`+`key` (`apiKey` / `api_key`).
  `maxTokens` (plural) and `apiKeyEnv` (an env-var name) are ordinary fields and are **not** redacted.
- Scalars are replaced with the fixed placeholder `__SECRET__` before entering a sync payload.
- On restore, the placeholder is filled from the local value with the **same key** inside the same
  entry (not by occurrence order), avoiding multi-provider mismatches. If the local entry has no such
  key, the placeholder is kept, the entry is reported in `skipped`, and the UI marks it "needs local
  value"; the placeholder is never written into your configuration.
- An inline `Bearer xxx` inside a normal string is left alone (to avoid damaging plain text).

### 4.3 Plugin manifest (MERGE-only)

| Situation | Action |
| --- | --- |
| remote only | `install` (writes an install plan only; never runs pnpm) |
| local only | `keep` (local-only plugins are **never deleted**) |
| remote version > local | `install` (upgrade) |
| local version > remote | `noDowngrade` (**never downgrades**) |
| same version | `keep` |
| unparsable source | `skip` |

Only metadata is synced (package name/version/source/enabled): **no code and no node_modules**.

### 4.4 Gitee HTTPS auth: username + private token

A GitHub PAT may be used with any non-empty username (the plugin defaults to `x-access-token`),
but **Gitee is different**: its HTTPS rule is "**Gitee login name as username + private token as
password**". Reusing `x-access-token` for Gitee only produces a 403/authentication failure hidden
inside git's output.

- With `Authentication = HTTPS`, the settings page shows a **Username** field (stored only in the
  local `settings.json`, never in `credentials.json`):
  - GitHub: may be empty → defaults to `x-access-token`;
  - **Gitee: required** — your Gitee login name (not an email, not the repository name); put the
    private token in "Access token";
  - Custom / self-hosted: follow the host's requirement; may be empty.
- When `platform = 'gitee'` and the username is empty, the Host fails before running git with
  `E_VALIDATION`: "Gitee requires a username (Gitee login name); the private token is the password".
- On save, a `gitee.com` URL left on the default GitHub platform is **corrected to Gitee and
  reported in the notice bar**; `gitlab.com` becomes "Custom". An explicit Gitee/Custom choice is
  never overridden.

### 4.5 Save-time repository precheck (fail closed)

`saveSettings` performs one authenticated vendor-API read **before** touching `settings.json` or
`credentials.json`:

- Gitee `GET https://gitee.com/api/v5/repos/{owner}/{repo}` with `Authorization: token <token>`;
- GitHub `GET https://api.github.com/repos/{owner}/{repo}` with `Authorization: Bearer <token>`;
- any other host is refused without sending a request (`E_REPO_HOST_UNSUPPORTED`). We never assume
  an unverifiable repository is private.

Only an explicit `private: true` passes. The typed codes and the Chinese messages are a byte-for-byte
mirror of the app's `model/repoVisibility.ts`; `test-vectors/repo-visibility/` (SHA256SUMS pinned) is
the shared source of truth: `E_REPO_AUTH` (401/403), `E_REPO_NOT_FOUND` (404), `E_REPO_PUBLIC`
(`private:false`), `E_REPO_BAD_RESPONSE` (missing/non-boolean `private`, HTML, malformed body),
`E_REPO_HOST_UNSUPPORTED`, and `E_REPO_VISIBILITY_UNKNOWN` (network error/timeout/5xx).

**Fail closed is intentional.** If the vendor API is unreachable the save is refused with
`E_REPO_VISIBILITY_UNKNOWN` and a retry-able Chinese message. Nothing is half-configured: on any
failure `settings.json` and `credentials.json` stay byte-identical, no clone directory is created,
and the typed code is recorded in `state.json` so `getState().status.repoBlockCode` never claims a
broken repository is healthy. A later clone failure (rotated/revoked token) updates the same code and
cleans up its quarantine directory, leaving neither `.git` nor `.git.clone-failed-*`. Only
`allowLocalRepo` (integration-test-only escape hatch for local bare repositories, which have no
vendor API) skips this gate. The token is only ever placed in the `Authorization` header — never in a
URL, error body, log line, or state dump.

## 5. Restore flow (fail-closed, four layers)

```
1. preview       preview → {previewId, sources:[{deviceId, entries, plugins, providers, mcp}]}
                 (read-only: writes nothing; cache TTL 10 minutes, one previewId per instance)
2. select        UI preselects added/changed; manual stays unselected and is marked
3. apply         apply {confirm:true, previewId, sourceDevice, entries}
   ├─ confirm !== true               → E_CONFIRM_REQUIRED, nothing written
   ├─ stale previewId/bad entries    → E_NOT_FOUND / E_VALIDATION (UI says "preview again")
   ├─ pre-write snapshot             → %USERPROFILE%\.dsh\vet\restore-snapshots\<ts>\
   ├─ replace selected entries only  (local secret values are restored; unrecoverable → skipped)
   ├─ atomic write                   (temp file + rename)
   └─ post-write whole-file SHA-256  → mismatch: roll back from the snapshot + E_SHA_MISMATCH
4. rollback      rollback {snapshotId, confirm:true} → {restored, verified:true}
```

Both "apply overwrite" and "roll back" are **two-step confirmations**: the first click expands a
confirmation bar, and only "Apply now" / "Roll back now" sends the request. Every write button is
disabled while a request is in flight and shows "…ing"; the component never calls setState after unmount.

## 6. Risk boundaries (explicit non-goals)

- **No force push**: non-fast-forward pulls run `pull --rebase` at most twice, then report `E_CONFLICT`.
- **No automatic semantic conflict resolution**: two devices changing the same line require a human
  choice between "adopt remote" and "keep local".
- **No cross-device deletion**: local plugins/entries missing from the remote are always kept.
- **No token in the browser**: the token passes through one `saveSettings` call; afterwards only
  `hasToken: true` represents it.
- **No changes to DSH itself or profile dependencies**: the plugin manifest only writes a plan file;
  the plugin never runs pnpm and never edits the profile `package.json`.
- **No YAML semantic rewrite**: only text-level block replacement, so `!!js` stays intact.
- **No cloud relay**: only you and your Git repository.

Known limitations:

- `preview` is in-memory: restarting DSH or previewing again invalidates the old `previewId` (the UI
  asks you to preview again).
- `plugins.to-install.json` is a plan only; installing still requires a manual step in DSH.
- Only four scopes are synced: `cordis.patch.yml`, providers, plugin manifest, and MCP. Session and
  workspace files are out of scope.
- `insert:` blocks merge as a whole keyed by their first inner id; keep one row per `insert:` entry
  (see 4.1).
- `getState` reads local state only and never uses the network; `reachable` is `true | false | null`
  (null = not probed). Network probes happen only on "test connection" / "push" / "preview", and each
  git network operation has an explicit budget, named by its constant rather than repeated here:
  `NETWORK_TIMEOUT_MS` for read commands (`ls-remote` / `fetch`), `FIRST_NETWORK_TIMEOUT_MS` for the
  process's **first** call (covers the askpass interpreter cold start), and `PUSH_TIMEOUT_MS` for push
  (it uploads local objects, so its cost grows with the work). The budget actually used is carried in
  `details.budgetMs` and quoted in the error text; "timed out" and "unreachable" are distinct results
  with distinct next steps. See `src/engine/git.ts` for the three constants.
- `apply` returns `fileSha256` for the whole post-write profile patch and `blockSha256` for one entry's
  text; they serve different purposes (write verification vs. entry tracking).

## 7. Troubleshooting

| Symptom | Code | Action |
| --- | --- | --- |
| Settings page shows "Network error" | `E_NETWORK` | DSH server stopped or the page disconnected; restart DSH and refresh |
| "Server returned HTTP 500" | `E_HTTP` | Check DSH logs; usually git is missing or the repository is unreachable |
| "DSH authorization rejected" | `E_AUTH` | The session lacks permission; sign in / reopen the GUI |
| Save fails validation | `E_VALIDATION` | Check the URL scheme (`https://`, `ssh://`, `git@host:path`), deviceId format, non-empty branch |
| Test connection fails | `E_GIT` / `E_AUTH` | Bad token or SSH key not loaded; use a least-privilege PAT for HTTPS, check `ssh-add -l` for SSH |
| Push rejected | `E_CONFLICT` | The remote has new commits and rebase conflicts; resolve that repository outside DSH first |
| "Preview expired, preview again" | `E_NOT_FOUND` / `E_VALIDATION` | Click "Preview remote" again; a previewId is single-use |
| "Post-write verification failed, rolled back" | `E_SHA_MISMATCH` | Another process changed the target file; close other editors/programs and retry |
| Manifest shows "No downgrade" | — | Local version is higher, as expected; downgrade manually if needed |
| Entry shows "Needs local value" | — | The remote field is `__SECRET__`; fill the key in the local entry by hand |

Suggested order:

1. "Test connection" → verify network/authentication.
2. "Preview remote" → verify read/write and merge results.
3. Select one entry → "Apply overwrite" → inspect `applied / skipped / snapshotId / verified`.
4. If unhappy, use "pre-write snapshot → roll back".

## 8. Implementation and verification status

- `src/client.js`: plain JS, passes `node --check`; the `en`/`zh` locales keep identical key sets
  (158 keys), and the inline dictionaries are byte-identical to `locale/*.json`.
- Rendering regression: `test/client-render.test.mjs` renders the settings panel with a
  React-semantics stub (children arrive through `props.children`) and asserts that inputs, selects,
  checkboxes, and action buttons survive.
- Host/engine behavior is covered by `node --test` in the repository root.
- **Not verified**: visual/interaction behavior inside a real, authenticated DSH Web GUI. The desktop
  GUI used for this review answered `dsh web authentication required`, so the rendered page remains
  unverified; component-level rendering and static bundle metadata are verified instead.
