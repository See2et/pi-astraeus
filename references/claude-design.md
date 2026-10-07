# Explicit Claude design delegation in Pi

Only an explicit user request for Claude permits this exception. A generic appearance
request, installed CLI or authenticated account is not authorization. Record the original
user quote in `design_request` and bounded `design_scope` at `start`, or once with
`authorize_design`. Scope labels are `design-direction`, `ui-implementation` (directly
related to the authorized design), and `design-direction-and-ui-implementation`.
Dispatch repeats the recorded label. Authorization lasts for the same task's bounded
follow-up fixes, never unrelated business logic or a new task. Root checks the actual
request and scope; these fields are caller attestations, not authenticated user consent.

Use role `designer`, exact logical pin `anthropic/claude-opus-5-5`, CLI argv model
`claude-opus-5-5` (no alias, older family, alternate provider or fallback). The installed
Claude Code CLI owns execution and its existing authentication. Pi Anthropic credentials
or catalog availability are not required. `thinking` is the requested CLI effort; it must
be explicitly supported by local help (low/medium/high/xhigh/max as available), never
clamped from an unsupported Pi level. Presence/help checks establish capabilities, not
account access, model identity or successful inference. Observed model/effort remain
unknown unless public CLI evidence actually supplies them. No login/auth changes,
installation, billing inspection, API/print fallback or permission bypass is performed.
The only authorized config update is the GPT-owned workspace trust preflight below.
General implementation, review, adjudication and acceptance stay on native GPT;
allowlisting Anthropic never permits general worker/reviewer/adjudicator dispatch.

## Design ownership and handoff

Opus owns discovery, design choices, related UI implementation, ordinary verification
and adopted fixes. Preserve composition, typography, color, assets and motion decisions
unless explicit user requirements or concrete functional constraints require change.
Give outcomes, references and real contracts, not root's preferred visual solution.
Follow-ups use the original owner, not a replacement GPT implementer. Fresh GPT review
assesses the user brief, usable behavior/contracts and rendered artifacts without turning
GPT taste into requirements. Astra remains preferred for visual acceptance; missing
Astra/render access must be disclosed. A report or source review is not visual acceptance.

New designers use installed Claude Code `--bg` in the current managed Git-root cwd,
not a new linked worktree. Initial explicit `--settings` includes
`worktree: {bgIsolation: "none"}` beside the existing `permissions` object. This is the
requested shared-working-copy policy: it disables the background worktree requirement,
not tool permission gates. `--safe-mode`, `dontAsk`, literal Edit/Write ownership,
allowed checks, denied tools/publication, empty `--setting-sources`, strict empty MCP
configuration and exact model/effort remain unchanged. Managed disjoint literal ownership
and cross-task review freezing remain. Initial ownership overlapping existing dirty user files is refused;
narrow it or ask the user to resolve the conflict manually. Never reset/stash/commit
user work to prepare dispatch. The initial snapshot preserves content/modes, Git index
and HEAD, including ignored outputs; collection rejects changes outside literal owned
paths and Git staging/history changes. Concurrent disjoint writes can conservatively
fail collection because a shared cwd cannot attribute outside-scope changes to their
writer. Sequence them if the designer needs a clean collection baseline.

This is not an OS sandbox. CLI permission settings supplement prompt/scheduling checks
and deny nested agents/publication; they cannot guarantee no writes outside the cwd.
Checks must be simple exact trusted verification commands, supplied in optional
`checks`; omitted means `[]`. Include generated outputs in ownership. Denied/failed
checks remain failures, never justification to relax permissions. Existing authenticated
CLI access remains a prerequisite; workspace trust is separate from tool permissions.
The bundled designer definition is checked against installed role definitions and its
contract is supplied in the handoff; native Pi tools/frontmatter are not CLI isolation.

Example delegate after authorized `start`:

```json
{"op":"delegate","task_id":"design-001","role":"designer",
 "model":"anthropic/claude-opus-5-5","thinking":"high",
 "design_scope":"ui-implementation","owned_paths":["src/card.tsx","src/card.css"],
 "checks":["npm run typecheck"],"prompt":"Implement the authorized card from the brief."}
```

## Bound lifecycle and evidence

Task state persists transport `claude-code-bg-v1`, requested model/effort, the observed
short ID/full UUID/cwd, freeze state and artifact hashes. Per-run artifacts live outside
the source under `$PI_CODING_AGENT_DIR/astraeus/SESSION/TASK/RUN`: request/baseline,
unique launch/resume/stop receipts, pending and validated final report. These are root
workflow artifacts, never private Claude transcripts. Launch/stop receipts retain argv,
stdout, stderr and exit, including failures. Dispatch state is saved before invocation;
failed evidence remains for inspection, with no blind retry.

Claude Code 2.1.288 `--bg` manages its own UUID. The bridge omits `--session-id`, parses
exactly one documented `backgrounded · <eight-hex-short-id>` stdout line, then requires
exactly one public `claude agents --json --all` record matching that short ID, full UUID
prefix and canonical cwd. It never binds by cwd/time alone. Missing/ambiguous IDs,
changed cwd, unknown output or failed launch are explicit unresolved states, not done.
Conflicting `sessionId`/`session_id` aliases are refused rather than choosing one.
Binding refusals carry a reason and bounded identity-only evidence in the saved workflow
error: expected short/full UUID, matching-record count, valid observed UUID aliases, and
SHA-256 fingerprints of canonical cwd paths when resolved. Malformed identity values,
raw paths, parser snippets and whole public records are not included. Fingerprints compare
canonical paths, not directory contents. Same-short resume inspection supplies the original
full UUID to this matcher; it cannot turn a conflicting identity into copy cleanup or a
new owner. Inspection uses one bounded public query, with no readiness retry, inferred
success from cwd/time, or automatic relaunch/resume. Without an error-time public record,
a later matching record cannot reconstruct the earlier refusal or prove a transient race.
Status/restore/active-job/review/accept gates track the CLI writer even without a native
manager. Existing native designer jobs keep their recorded native behavior or require
explicit recovery; they are never silently migrated to CLI.

Successful collection explicitly runs `claude stop <bound-short-id>` and retains an
exit-zero `stopped <bound-short-id>` acknowledgment before validating source/report.
The public post-stop record must affirm `done`/`stopped`, no live pid, and idle or omitted
status. Idle/done alone can still have a live process; it is not a writer freeze.
Unknown or missing lifecycle does not become successful completion. Stop preserves files
and conversation, but does not upgrade a blocked/failed report.

Resume requires the latest collected/frozen run of the original owner and the existing
adopted-fix review/adjudication gates. It stops the exact owner again before invoking:

```sh
claude --bg --resume OBSERVED_FULL_UUID -- "Run-specific bounded follow-up"
```

No configuration overrides (model, effort, settings, permission flags) are repeated:
2.1.288 retains saved options, and overrides or a live idle session can cause a copy.
The resume receipt must emit the original short ID and public inspection must confirm
the identical full UUID/cwd. An unexpected emitted copy is verified and stopped exactly,
with evidence retained; it never replaces the owner binding. A failed/unknown copy stop
keeps freezing unresolved. Inspect changes/evidence before recovery, never retry blindly.

Deploying a new Pi package changes only new initial launches. Existing sessions retain
their saved settings on resume; old launch receipts without `worktree.bgIsolation` do not
acquire `none` retroactively. The old background worktree guard may therefore persist.
Do not add settings/model/permission overrides to an existing resume to force it off:
that can copy the session and is not supported owner migration.

For manual recovery, first inspect the retained launch/resume/stop receipts and latest
workflow error, then obtain one bounded public observation for the exact owner and cwd.
A current exact match establishes only current identity/lifecycle. Recover and validate
the latest run-specific report and actual owned delta through collection, including exact
stop acknowledgment and affirmative frozen lifecycle; missing/invalid reports, ambiguous
identity, unknown lifecycle, unresolved copy freezes or out-of-scope changes remain
blocking. Preserve the original owner, latest collected/frozen run, bounded task scope and
any required adopted-fix decision before invoking managed `resume`. This does not promise
that an old session can edit the shared checkout under its saved guard. If it remains
blocked, leave it unresolved and ask the user for an explicit recovery/migration decision,
rather than editing private sessions/config, overriding saved options or launching a
replacement automatically. Historical offending records not retained cannot be recovered
from a later status listing. No real affected-session resume is required for deployment QA.

## Workspace trust preflight

Immediately before each initial `--bg` launch and after the exact owner stop before
resume, GPT runs a bounded preflight. For a cwd and actual Git root both strictly under
canonical `homedir()/ghq`, it registers only
`projects[canonicalGitRoot].hasTrustDialogAccepted = true` in writable `~/.claude.json`.
Nested repositories use their own actual root; symlink/sibling escapes, an external Git
parent, and ghq/home/filesystem parent trust are never registered. No unrelated clones
are enumerated. Git environment overrides cannot manufacture the discovered root.
Outside the boundary, launch retains existing manual workspace-trust behavior.

This is a narrow user-authorized runtime exception to the no-global-config-write rule,
not permission bypass, authentication management, or a new execution mode. Other
project fields, tool permissions, auth/session values, even unrelated JSON number tokens
and formatting are preserved by a minimal textual change, never reset/stringified.
Existing true is a no-write operation and does not inspect or stop unrelated sessions.
Malformed JSON, duplicate decoded keys and invalid object/trust shapes are refused,
without parser snippets or config values in errors/evidence. Only the current process's
owner-only regular readable/writable file is eligible: symlinks (including Nix-managed
links), hardlink aliases, public/read-only files and unsafe directories are refused.
An absent config is exclusively created with mode 0600. `CLAUDE_CONFIG_DIR` is rejected
for eligible repositories: its override mapping has not been established from installed
CLI/public documentation, so the default file must not be guessed.

When a mutation is needed, a cooperative exclusive lock, public `agents --json --all`
listing and native Linux/Darwin `ps` observations require no observed active or unknown
Claude sessions/processes. Missing capabilities, incomplete process output/visibility
and lock contention block mutation; never kill unrelated processes or remove another
writer's lock. Linux additionally checks `/proc` mount visibility with `findmnt`;
Darwin uses native macOS `ps` without `findmnt` or `/proc`. Unsupported platforms require
manual trust for an update. Darwin process observation is mock-tested, not runtime-verified.
Already trusted repositories still need only the regular CLI lifecycle checks.
CLI observation can itself write config, so changed pre/post-observation snapshots block
the update rather than merging stale bytes. A second process census and immediate
metadata/content re-read before atomic publication catch observed noncooperating writes.
Temporary files are 0600 and cleanup removes only owned artifacts. Trust config bytes
are never copied to Git, Store, reports or lifecycle receipts.

This is not strict cross-process exclusion: Claude does not participate in this package's
cooperative lock. A new writer or noncooperating update can race the final comparison
and rename; the process census is limited to visible processes. No OS sandbox, race-free
CAS, crash-proof cleanup or durable directory fsync guarantee is claimed. A stale lock
blocks future updates until the user confirms the writer is gone and removes it manually.

If preflight or stderr reports a remaining workspace trust/authentication failure,
disclose it and ask the user to resolve it interactively for that exact cwd. Never alter
auth, read private sessions or switch inference modes. A failed managed launch remains
unresolved; this package does not automatically spawn a replacement owner or infer
success from an empty listing.

## Structured result and acceptance

The designer writes only its assigned run-specific `pending/RUN.json`, following
[implementation.json](../schemas/implementation.json) with exact task ID, run ID and
initial dispatch target ID. Root owns the final `result.json`. The conversation need
not be JSON; background schema enforcement is unavailable, so the contract is prompted
and post-validated. A follow-up receives a new pending filename and baseline, preventing
reuse of an old valid report. The original CLI session has a bounded writable pending
report directory, so saved permissions allow those new filenames without resume
overrides. Request/lifecycle/final artifacts are outside that writable directory;
publication removes the pending alias so it cannot mutate the root-owned final bytes. Report actual changed_files relative to this run, every
required command's truthful outcome/evidence, and remaining issues. Complete means
completed authorized work, required checks passed and no remaining work. Empty checks
means `checks: []`, not an invented not_run verification.

Collection checks JSON schema/duplicate keys/bindings, complete status, all required
checks passed, remaining empty, and exact actual owned baseline delta. Symlinked reports,
Git HEAD/index changes, out-of-owned changes including ignored files, or mismatched
changed_files fail. Root rechecks the frozen bound session, lifecycle evidence, source
snapshot and report before exclusive publication of the original validated bytes.
Failed evidence stays available; stopping never repairs an invalid report automatically.

Collection is not final acceptance. Consequential work still needs fresh native GPT
review, optional separate adjudication only after complete changes_required, root diff
and evidence examination, and current-source rechecks. The managed review target hashes
HEAD, tracked staged/unstaged diffs and nonignored untracked files; ignored outputs and
external services need separate evidence. If relevant source lies outside the managed
cwd, root must separately hash/freeze that exact external source and bind fresh review
evidence to it, then recheck both external and managed targets before acceptance.
No procedural receipt establishes truth, independence, sandboxing or visual acceptance.

Automated lifecycle tests use only fake public CLI responses; real GPT-route regressions
use a deterministic local provider. No automated live inference. Separate bounded manual
live QA requires explicit authorization and should retain launch, exact ID/cwd, report,
stop and same-ID follow-up evidence. Compatibility observations from upstream 2.1.288
inform these gates but do not prove every installed account/version will succeed.
