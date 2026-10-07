# pi-astraeus

Astraeus policy and evidence-bound review workflow for Pi Coding Agent, using
[Tintinweb pi-subagents](https://github.com/tintinweb/pi-subagents) for native GPT child execution.
Explicitly authorized designers use the already installed Claude Code `--bg` lifecycle.
This package does not implement authentication, a model runtime, or an OS sandbox.

## What loads

- Three skills: `pi-astraeus-orchestrate`, `pi-astraeus-review`, `pi-astraeus-adjudicate`.
- One extension: `astraeus_workflow` tool, `/astraeus` diagnostics, startup guidance,
  target-freeze hooks, branch-aware workflow state and status display.
- Four agent definitions with no model/thinking pins. Worker/designer owns implementation
  and ordinary verification; reviewer/adjudicator have only `read,grep,find,ls`.
- Upstream Astraeus schemas and Python validator, with provenance in `UPSTREAM.md`.

Simple work stays solo. Important work gets fresh independent review; a complete
`changes_required` review gets a separate fresh adjudicator. Root decides scope and
final acceptance. A validated JSON report does not prove its claims are true.

## Installation

The user's Nix flake pins both repositories. Its Pi wrapper loads both package roots,
provides Python with `jsonschema`, and Home Manager installs exactly these files:

```
~/.pi/agent/agents/astraeus-worker.md
~/.pi/agent/agents/astraeus-designer.md
~/.pi/agent/agents/astraeus-reviewer.md
~/.pi/agent/agents/astraeus-adjudicator.md
```

Outside Nix: install Tintinweb pi-subagents, provide Python 3.11+ with jsonschema 4.x,
copy the four bundled definitions into `$PI_CODING_AGENT_DIR/agents` (default
`~/.pi/agent/agents`), then load this root with `pi -e /path/to/pi-astraeus`.
Use `PI_ASTRAEUS_PYTHON` only to select a preinstalled Python interpreter.
Do not overwrite existing customized definitions without inspecting them.

No authentication values or Pi settings are managed by this package. A narrowly
authorized GPT-owned preflight updates only Claude's canonical `~/ghq` Git-root
workspace trust flag, preserving every unrelated config/auth/session value. Close existing
Pi processes before updating packages, apply the host's normal manual rollout gates,
and start a fresh Pi process. Editing this source does not reload an already running
installed Nix tool: the user must update/reload the package before new operations are
available. Never patch private sessions or mutable workflow state to emulate deployment.
NixOS `test`/`switch` and Darwin activation remain user-only.

## Use

Give Pi an ordinary request. Startup guidance activates the orchestration skill;
there is no mandatory plan command or fixed research/plan/implementation chain.
`/astraeus` shows policy, available models and current tasks. `/astraeus TASK` narrows
status to one task. Root uses the model-only `astraeus_workflow` tool as follows:

| Operation | Required fields / behavior |
|---|---|
| `start` | `task_id`, `requirements`, `acceptance`; include constraints/non-goals/preserved contracts in `constraints`. `consequential` defaults true. Git repository root required. |
| `authorize_design` | `task_id`, original explicit user quote in `design_request`, bounded `design_scope`; record once for an existing task. The same optional fields may be included at `start`. |
| `delegate` | `task_id`, `role`, exact `model` provider/id, supported `thinking`, bounded `prompt`; worker/designer `owned_paths` are literal relative paths, default `.`. Designer optionally supplies `checks` (absent means `[]`). |
| `collect` | `task_id`, `run_id`; reports running promptly, validates settled outcomes. No repeated tight polling. |
| `reconcile_generated` | Deprecated compatibility alias for recollecting the latest original collected/frozen designer; no cache fingerprints/approval needed, `generated_outputs` ignored. Prefer `collect`. See [retired reconciliation](references/claude-design.md#retired-generated-output-reconciliation). |
| `resume` | `task_id`, original worker/designer `run_id`, follow-up `prompt`; uses native Agent continuation for workers/legacy native designers, or exact stopped Claude UUID for CLI designers; never resumes a reviewer/adjudicator. |
| `stop` | `task_id`, `run_id`; stops only this managed child, then collect its incomplete outcome. |
| `status` | Optional `task_id`; checks current target and restores explicit incomplete states. |
| `invalidate` | `task_id`; marks the reviewed target stale before new work. Does not waive pending children. |
| `accept` | `task_id`; checks managed results and current review/court verdict. Root still examines scope, evidence and truth. No activation or deployment. |

Role definitions must match the bundled contracts, including aliases under other
filenames, so project overrides cannot quietly change tools or pin another model.
Concurrent writers across managed tasks in the same repository need disjoint literal path ownership. This is a scheduling check,
not an enforced filesystem boundary. Root shell/edit/write tools are blocked while a
managed reviewer/adjudicator is active; external processes are not frozen, so their
changes invalidate the target. Native Agent/Workflow tool calls are routed through
the managed tool while a task is incomplete; direct human Tintinweb controls remain available.

The managed flow is:

```
implementation + ordinary verification (same owner)
  -> collect -> stable target -> fresh reviewer -> collect
     pass             -> root evidence/current-target checks -> accept
     changes_required -> fresh adjudicator -> collect
                          reject all -> root checks -> accept
                          adopted fixes -> resume original worker -> fresh review
     inconclusive     -> obtain bounded missing evidence -> fresh review
```

Native worker output is concise prose describing actual changes and checks. CLI designers
write a run-bound implementation JSON to their run-specific pending report. Reviewer and
adjudicator output is exactly one JSON object (one JSON fence is tolerated), matching
the supplied schema. Readonly reviewers cannot write report artifacts; root captures
and validates their returned bytes. Failed, malformed, interrupted or
stale results stay incomplete. No fixed review-attempt cap is imposed.

## Explicit Claude design request

After the user explicitly requests Claude for design, root records `design_request`
with the original user quote and `design_scope` as `design-direction`,
`ui-implementation` (directly related UI work), or
`design-direction-and-ui-implementation`. Then delegate role `designer`, exact
`anthropic/claude-opus-5-5` (logical exact model pin), supported CLI effort in `thinking`,
and the matching `design_scope`. CLI argv uses `claude-opus-5-5`, not an alias.
No other Anthropic model or provider fallback is launched; regular worker/reviewer/
adjudicator routes reject Anthropic even if allowlisted. This is a scoped exception
outside regular GPT allowed_models, not a global model policy expansion.

The quote is root-reported, not authenticated user consent; scope labels cannot
semantically guarantee a prompt is in scope. Root checks the real request and each
assignment. Authorization persists only for the same task and its bounded fixes.
Opus owns discovery, design, related UI implementation, verification and adopted
fixes; `resume` continues that same owner. GPT performs fresh independent review,
adjudication and final acceptance, respecting Opus design choices unless a user
requirement or functional constraint requires change.

This path uses installed Claude Code `--bg`, retaining its existing authentication and
permissions. It requires supported CLI capabilities, not Pi Anthropic credentials or a
catalog entry. No installation, login change, API/print fallback or permission bypass
is performed. New initial launches explicitly set `worktree.bgIsolation: "none"` in
`--settings` to use the current shared checkout. Edit/Write permissions cover the repository,
with Git/workflow controls protected; bounded pending reports are separately writable.
`--safe-mode`, exact model/effort, `dontAsk`, empty `--setting-sources` and strict MCP
remain. Managed disjoint ownership remains; no linked worktree or OS sandbox is claimed.
Existing sessions keep saved options on resume: deployment does not retroactively change
old ownership permissions or a worktree guard, and adding resume overrides to force
migration can create a copy. `owned_paths` is advisory assignment/scheduling like native
GPT workers, not per-file edit restrictions or baseline-delta acceptance gates; explicit
design scope remains bounded. Dirty assigned files do not blanket-block dispatch:
preserve user work by instruction, never reset/stash it. Collection stops the exact
UUID/cwd writer and records run-bound outcomes separately from acceptance. Outside-source,
ignored-generated and later shared-cwd deltas alone do not block collection/recollection
or acceptance; root still judges scope, user work and unauthorized staging/history.
Before start/resume, GPT registers only the actual canonical Git root under canonical
`~/ghq` in writable `~/.claude.json`; existing true is a no-write/no-session-inspection
operation. Outside that boundary workspace trust remains manual. Unsafe config,
unknown/active sessions or observed concurrent writes block a needed update and launch.
`CLAUDE_CONFIG_DIR` overrides fail closed because their config mapping is not established.
Binding errors retain specific refusal reasons and minimal UUID/canonical-cwd fingerprint
evidence, not whole public records. Conflicting UUID aliases, missing/ambiguous identities
and cwd mismatches fail closed; no automatic readiness retry or owner replacement occurs.
A later exact match is current evidence, not reconstruction of an unsaved error-time record.
Safe resume requires the exact original owner, latest collected/frozen run, immutable
evidence integrity, bounded scope and required adopted fixes. Failed original runs can
resume for correction without a successful prior report; incomplete/failed work is not
automatically accepted. Old saved permissions/guards may remain blocked.
See [Claude design delegation](references/claude-design.md) for lifecycle, trust and recovery.

Session-scoped monitoring observes only each Claude owner's latest uncollected run.
Transitions send bounded `followUp` messages with `triggerTurn: true`, including when
root is idle. `work-ended` means public done/idle evidence, ready to attempt collect,
not implementation success. `blocked`, external `stopped`, and `unknown` require
attention and never imply success. Repeated observations do not wake root again;
a resumed run has a new notification identity. Observation remains separate from
`cli.frozen` (explicit exact stop acknowledgment) and `valid` (strict report checks).
Monitoring never stops, collects, or accepts work automatically.

One owner is polled per tick, without overlapping workflow operations; failed
observations back off from 3 seconds to at most 30 seconds. Public CLI queries have
a 5-second timeout and 256-KiB combined output limit. Cancellation kills only the
query child, never the background owner. Before tree navigation, monitoring retires
in-flight reads and pauses while Pi reports non-idle navigation/summarization.
Cancellation, summary abort or summary error automatically resumes polling on the
unchanged branch, without a parent interaction. Successful navigation restores the
selected branch with a fresh monitor generation. Session replacement, reload and
shutdown dispose monitoring; retired observations cannot mutate or notify another
branch/session. Unhandled restored transitions remain noticeable.

## Policy and evidence

Only the current Git root's `astraeus.toml` is read. Keys preserve Astraeus's format:
`schema_version`, `allowed_models`, `require_review_globs`, `assurance`.
Automatic candidates are GPT-6.1 Sol for root, ordinary workers and fresh independent
reviewers/adjudicators; GPT-6 Luna for narrow work with cheap objective checks; and
GPT-6 Astra for demanding reasoning or visual judgment. Select capability upfront,
without a mandatory cheap-first ladder. Fresh same-model review is independent.
See the [adopted routing assessment](references/routing-proposal.md) for dated rates,
supported thinking guidance and verification limits. Older GPT models are excluded
from defaults; preserve explicitly authorized legacy pins through project
`allowed_models`. A bare ID restricts IDs; it never chooses a provider. Actual dispatch
for GPT requires an exact available Pi provider/model and thinking level; the designer
exception requires its exact logical pin and installed CLI capabilities. No fuzzy matching, effort clamping, provider
substitution, API charging fallback, or account changes are used to recover.

Example preserving an explicitly selected legacy pin (no automatic fallback):

```toml
schema_version = 1
allowed_models = ["openai/gpt-5.5"]
require_review_globs = ["modules/*", "home/*"]
assurance = "reported"
```

Glob matching uses Python fnmatchcase (including `*` across `/`). Mandatory paths
add to risk-based review requirements; consequential changes cannot opt out. Renamed
paths count at both old and new locations.

Reported receipts record requested model/thinking separately from observed child
session/invocation values, with unavailable observations as null. Known mismatches
fail result collection. Native metadata is not a provider/billing attestation.
**Strict review/adjudication is refused before dispatch**, because this integration
has no attested OS read-only sandbox. Built-in tool restrictions are not OS isolation.

Target hashing covers HEAD, staged/unstaged tracked diffs and nonignored untracked
files. Ignored outputs, external services and dependencies are not hashed; root must
identify relevant render/verification evidence separately. Results and receipts live
outside the Git tree under `$PI_CODING_AGENT_DIR/astraeus/SESSION/TASK`, mode 0600,
so saving them does not change target identity. Claude per-run request, launch/stop,
pending/final result artifacts live in an additional `RUN` directory. Its collection
baseline includes ignored files, unlike the source review target. Result/receipt hashes are checked again
at acceptance; adjudication binds to the exact original review bytes.

Model-facing tool text **and details**, startup guidance and `/astraeus` diagnostics
use an allowlisted orchestration view, not raw workflow snapshots. The view keeps run
identity, status/valid/collected flags, requested versus observed settings, actionable
findings and artifact references; it excludes the designer baseline/files/index.
Strings are limited to 1,024 characters, arrays to 12 items, and each serialized view
to 8 KiB (the complete registered tool response stays below 24 KiB). Tasks and jobs
show newest first. Omission counts and total/attention-job counts are explicit:
omitted evidence is not a successful check or permission to accept. Narrow status to
a task and read referenced reports/receipts/lifecycle artifacts in bounded slices.
Full snapshots, including ignored files, remain in non-context custom metadata and
designer request artifacts; collection and ownership verification still use them.

On restored legacy sessions, the Pi `context` hook replaces only Astraeus tool-result
payloads and guidance before model input, including giant results retained by
compaction. It preserves tool-call IDs/error flags and leaves signed assistant
reasoning, unrelated messages and raw history unchanged. Legacy JSON text-only
results are projected; malformed payloads (or text over the 16 Mi-character recovery
parse limit) become a compact diagnostic, never an echo of the original. Repeated old
guidance is replaced by one bounded current view, not fresh lifecycle evidence.
Compaction and branch-summary preparation receive the same payload sanitation.
Existing anonymous compaction/branch summary prose is not rewritten, nor are
exports/raw history or private sessions migrated; restart with the updated extension
to enable recovery.

Workflow snapshots use Pi custom session entries and restore from the active branch,
not abandoned branches. Pi session identity controls ownership; there is no extra
session database. If a process restart loses a live Tintinweb child record, it is
shown as unavailable, never successful. Collecting a lost attempt settles it as
unsuccessful while preserving history, so a fresh reviewer can supply new evidence
in the same task. Lost implementation work still blocks acceptance; use Tintinweb's
saved-session/@handle recovery controls, since managed continuation requires the
original live record/session. CLI designers restore their recorded transport and observed
UUID from task state, verify it via public `agents --json --all`, and never read private
transcripts. Missing/unknown lifecycle is not completion and blocks writer freezing.
Legacy native designer jobs stay native or require explicit recovery, never migrate.
Missing review evidence is never invented. Artifacts are local
and are not automatically uploaded.

## Development and verification

```
npm ci --ignore-scripts
npm run typecheck
uv run --with 'jsonschema>=4.23,<5' python -m unittest discover -s tests/python -v
uv run --with 'jsonschema>=4.23,<5' python -c 'import os,subprocess,sys; os.environ["PI_ASTRAEUS_PYTHON"]=sys.executable; sys.exit(subprocess.call(["npm","test"]))'
```

Registration-level context regressions use 15,173 synthetic baseline files, legacy
retained tool responses, startup/compaction hooks and many long tasks/jobs/findings.
They assert bounded output and intact restored baseline/out-of-ownership checks.
Tests cover target invalidation, schema/hash binding, verdict transitions, fallback
rejection, role overrides, writer ownership and branch recovery. The native test loads
both real extension factories with Pi 1.0.4 and exercises real child sessions using a
local deterministic provider for GPT-route fresh review and same-owner continuation.
The former Pi-native Anthropic designer regression is intentionally retired. Fake public
Claude CLI lifecycle tests cover launch/stop evidence, observed UUID/cwd binding,
stop-before-resume, copied-owner rejection, run reports, dirty baseline preservation,
and owned/ignored deltas. Automated tests never invoke live inference or read personal
auth; bounded live Claude QA is a separate explicitly authorized manual gate. Set `PI_ASTRAEUS_SUBAGENTS` to a built/pinned Tintinweb package root to
qualify that exact source instead of the locked development npm package.
