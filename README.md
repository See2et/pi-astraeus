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
and start a fresh Pi process. NixOS `test`/`switch` and Darwin activation remain user-only.

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
is performed. The current repository cwd and managed disjoint ownership remain; no
linked worktree or OS sandbox is claimed. Collection stops the exact observed writer,
validates its run-bound report/checks and actual baseline delta, and rejects changes
outside literal ownership. Existing dirty user files cannot be owned on initial dispatch;
narrow ownership or resolve that conflict manually, never reset/stash user changes.
Before start/resume, GPT registers only the actual canonical Git root under canonical
`~/ghq` in writable `~/.claude.json`; existing true is a no-write/no-session-inspection
operation. Outside that boundary workspace trust remains manual. Unsafe config,
unknown/active sessions or observed concurrent writes block a needed update and launch.
`CLAUDE_CONFIG_DIR` overrides fail closed because their config mapping is not established.
See [Claude design delegation](references/claude-design.md) for lifecycle, trust and recovery.

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
