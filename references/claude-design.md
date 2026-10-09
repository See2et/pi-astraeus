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
not tool permission gates. `--safe-mode`, `dontAsk`, allowed checks, denied
nested agents/publication, empty `--setting-sources`, strict empty MCP configuration
and exact model/effort remain. Edit/Write allows cover the managed repository, excluding
`.git` and `.astraeus` workflow controls; only the bounded external pending report
directory gets an additional write allow. Request/lifecycle/final artifacts stay protected.

`owned_paths` remains validated literal assignment/scheduling scope, advisory like native
GPT workers. It does not broaden explicit design authorization. Disjoint scheduling and
cross-task review freezing remain. Dirty assigned source does not blanket-block dispatch:
preserve existing user work by instruction, never reset/stash/commit it to prepare dispatch.
Snapshots retain content/modes, index and HEAD as evidence, not attribution. Outside-source,
ignored-generated, later shared-cwd, index or HEAD deltas alone do not block collection,
recollection, resume or acceptance. Root's current-target scope/evidence review must still
judge unauthorized edits, user-work loss and staging/history. Collection is not acceptance.

This is not an OS sandbox. CLI permission settings supplement prompt/scheduling checks
and deny nested agents/publication; they cannot guarantee no writes outside the cwd.
Checks must be simple exact trusted verification commands, supplied in optional
`checks`; omitted means `[]`. Generated outputs need no ownership expansion or
reconciliation approval. Denied/failed checks remain unsuccessful outcomes, never
justification to relax permissions. Existing authenticated
CLI access remains a prerequisite; workspace trust is separate from tool permissions.
The bundled designer definition is checked against installed role definitions and its
contract is supplied in both initial and follow-up CLI handoffs; native Pi tools/frontmatter
are not CLI isolation. Background designers run unattended: never ask user questions,
request interactive input/approval, use AskUserQuestion/plan approval/interactive commands,
or wait for chat. For minor ambiguity, assume safely within the original authorized scope
and report assumptions in the summary. Genuinely missing authority/input ends in the assigned
run-specific JSON report with `status: "blocked"`, truthful checks, concrete blocker/options
for root in `remaining`, and completed work preserved. Root handles user decisions. These
prompt instructions are not guaranteed runtime enforcement and do not authorize permission
changes, broader scope or automatic acceptance.

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
new owner. Ordinary identity inspection uses one bounded public query. Only post-launch,
post-resume and acknowledged post-stop readiness (including exact unexpected-copy cleanup)
uses a bounded observation-only window: at most 10 queries within 5 seconds, with 100-ms
cancellable waits and the existing per-query timeout/output bound. Missing/temporarily
incomplete UUID/cwd fields, an unresolvable observed cwd, malformed/unavailable observations,
and a not-yet-affirmative post-stop lifecycle are `CLAUDE_OBSERVATION_UNCERTAIN` on exhaustion,
not identity-conflict evidence. Ambiguous records, conflicting UUID aliases, prefix/expected
full-UUID mismatch and a different resolved canonical cwd remain `CLAUDE_BINDING_REFUSED`
and fail immediately. The window never repeats launch/resume/stop, infers identity by
cwd/time, freezes on unknown, adopts copies or fabricates evidence. A later matching record
establishes current identity only; it cannot reconstruct an earlier unsaved conflict.
Status/restore/active-job/review/accept gates track the CLI writer even without a native
manager. Existing native designer jobs keep their recorded native behavior or require
explicit recovery; they are never silently migrated to CLI.

Successful collection explicitly runs `claude stop <bound-short-id>` and retains an
exit-zero `stopped <bound-short-id>` acknowledgment before validating source/report.
The public post-stop record must affirm `done`/`stopped`, no live pid, and idle or omitted
status. Idle/done alone can still have a live process; it is not a writer freeze.
Unknown or missing lifecycle does not become successful completion. Readiness exhaustion
leaves the writer unfrozen/uncollected and eligible for monitoring; acknowledgment alone is
not affirmative freeze. Stop preserves files
and conversation, but does not upgrade a blocked/failed report.

Resume requires the latest collected/frozen run of the original owner and the existing
adopted-fix review/adjudication gates. Failed, missing or malformed original reports may
resume for correction: successful work is not a recovery prerequisite. Exact UUID/cwd,
retained request/model/effort/lifecycle integrity, affirmative freeze and no unexpected copy
remain prerequisites. Published report bytes/bindings are revalidated if present; tampering
with immutable reports/evidence remains blocking. A new run does not erase the old failure
or count it as success. It stops the exact owner again before invoking:

```sh
claude --bg --resume OBSERVED_FULL_UUID -- "Run-specific bounded follow-up"
```

No configuration overrides (model, effort, settings, permission flags) are repeated:
2.1.288 retains saved options, and overrides or a live idle session can cause a copy.
The resume receipt must emit the original short ID and public inspection must confirm
the identical full UUID/cwd. A dispatched resume whose readiness observations exhaust the
budget remains uncollected/unfrozen: session monitoring can later recover current lifecycle
and notify root without another user prompt, never by redispatching resume or automatically
collecting/accepting it. An unexpected emitted copy is verified and stopped exactly,
with evidence retained; it never replaces the owner binding. Even a successfully stopped
copy remains unsuccessful: its report cannot be collected as valid or used to authorize
resume or acceptance, including when restoring state from an older version. If the
emitted different ID fails binding inspection, its short ID is retained as unverified:
no blind stop, automatic rebinding from a later listing, or successful report collection
is permitted. A failed/unknown copy stop keeps freezing unresolved. Inspect changes/evidence before recovery, never retry blindly.

Deploying new launch permission/worktree settings changes only new initial launches.
Updated unattended handoff guidance is supplied on managed start/resume after normal package
update and Pi reload, but is prompt guidance rather than guaranteed enforcement.
Existing sessions retain
their saved settings on resume; old launch receipts without `worktree.bgIsolation` do not
acquire `none` retroactively. Old ownership-scoped permissions and the background
worktree guard may therefore persist; repo-scoped permissions apply only to new initial
launches. Do not add settings/model/permission overrides to an existing resume to force migration:
that can copy the session and is not supported owner migration.

For manual recovery, first inspect the retained launch/resume/stop receipts and latest
workflow error, then obtain one bounded public observation for the exact owner and cwd.
A current exact match establishes only current identity/lifecycle. Collect the latest
run's outcome, including failure, with exact stop acknowledgment and affirmative freeze.
Missing/invalid reports do not prevent correction resume, but cannot authorize acceptance.
Ambiguous identity, unknown lifecycle, changed immutable evidence and unexpected copies
remain blocking. Preserve the original owner, latest collected/frozen run, bounded task scope and
any required adopted-fix decision before invoking managed `resume`. This does not promise
that an old session can edit the shared checkout under its saved guard. If it remains
blocked, leave it unresolved and ask the user for an explicit recovery/migration decision,
rather than editing private sessions/config, overriding saved options or launching a
replacement automatically. Historical offending records not retained cannot be recovered
from a later status listing. No real affected-session resume is required for deployment QA.

## Autonomous parent attention

Session monitoring polls only each owner's latest uncollected run, independently of user
input. Lifecycle transition notices are appended once. Streaming parents receive native
follow-ups; preparation/manual compaction does not authorize a competing run. Public
`AgentSession.prompt` and `sendCustomMessage` completion are observed under the pinned SDK,
without editing upstream. Delivery remains pending until actual `agent_start`; handled or
failed user/notification preparation retains that obligation. A session-owned idle timer
retries with hidden attention wakes, backing off from 100 ms to 5 seconds, without a new
prompt, status call or changed public record. It does not resubmit rejected user input.
A complete extension reload retains the unconsumed obligation in the session-owned observer,
not in the retired timer. The replacement owner recovers it when any unconsumed appended
notice still belongs to the same session's public branch. Subsequent notices or workflow
saves do not overwrite earlier anchors; branches retaining none of those notices and
different sessions do not inherit its attention.
Retired runtime owners cannot wake another branch/session. This is runtime adaptation,
not guaranteed model obedience; SDK upgrades require compatibility verification. Polling
and attention never automatically stop, collect, accept, replace or migrate designers.

## Retired generated-output reconciliation

The Vitest-specific approval/fingerprint mechanism is retired with hard ownership deltas.
Ordinary `collect` now recollects persisted delta-only failures without generated-output
receipts, exact cache hashes or Vitest-specific checks. Historical failure evidence and
old approval bytes remain immutable evidence; their obsolete source fingerprints are not
current collection/acceptance gates. No historical observations or success are fabricated.

`reconcile_generated` remains a deprecated compatibility alias for recollection of the
latest original collected/frozen designer; `generated_outputs` is ignored. Prefer `collect`.
Exact identity/freeze/evidence/report checks and fresh native review/adjudication gates
remain. No replacement owner, permission override or saved-session migration is performed.

Editing this repository does not reload an already running installed Nix package/tool.
The user must arrange the normal package update and fresh Pi process/reload before the
new operation exists in that runtime. Agents must disclose this boundary; never patch
Pi/Claude sessions, authentication/config or mutable workflow control files to emulate it,
and never run NixOS/Darwin activation on the user's behalf.

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

Collection checks JSON schema/duplicate keys/task-run-target bindings and publishes the
original captured bytes as an outcome, including blocked/failed work or failed checks.
Only complete authorized work with all required checks passed and no remaining issues
sets `valid`; incomplete/failed reports and missing reports cannot authorize acceptance.
`changed_files` is the owner's edit report, not an exact match to full-repo baseline deltas
that can include other writers. Symlinked reports and mutated immutable evidence fail.
Root rechecks the frozen bound session, lifecycle evidence, source stability during
collection and report before exclusive publication. Later shared-cwd changes require
current-target review, not attribution against an old run baseline. Failed evidence stays
available; stopping never repairs an invalid report automatically.

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
