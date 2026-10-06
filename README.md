# pi-astraeus

Astraeus policy and evidence-bound review workflow for Pi Coding Agent, using
[Tintinweb pi-subagents](https://github.com/tintinweb/pi-subagents) for child execution.
This package does not implement authentication, a model runtime, or an OS sandbox.

## What loads

- Three skills: `pi-astraeus-orchestrate`, `pi-astraeus-review`, `pi-astraeus-adjudicate`.
- One extension: `astraeus_workflow` tool, `/astraeus` diagnostics, startup guidance,
  target-freeze hooks, branch-aware workflow state and status display.
- Three agent definitions with no model/thinking pins. Worker owns implementation
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
~/.pi/agent/agents/astraeus-reviewer.md
~/.pi/agent/agents/astraeus-adjudicator.md
```

Outside Nix: install Tintinweb pi-subagents, provide Python 3.11+ with jsonschema 4.x,
copy the three bundled definitions into `$PI_CODING_AGENT_DIR/agents` (default
`~/.pi/agent/agents`), then load this root with `pi -e /path/to/pi-astraeus`.
Use `PI_ASTRAEUS_PYTHON` only to select a preinstalled Python interpreter.
Do not overwrite existing customized definitions without inspecting them.

No authentication files or Pi settings are managed by this package. Close existing
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
| `delegate` | `task_id`, `role`, exact `model` provider/id, supported `thinking`, bounded `prompt`; worker `owned_paths` are literal relative paths, default `.`. |
| `collect` | `task_id`, `run_id`; reports running promptly, validates settled outcomes. No repeated tight polling. |
| `resume` | `task_id`, original worker `run_id`, follow-up `prompt`; uses native Agent continuation, never resumes a reviewer/adjudicator. |
| `stop` | `task_id`, `run_id`; stops only this managed child, then collect its incomplete outcome. |
| `status` | Optional `task_id`; checks current target and restores explicit incomplete states. |
| `invalidate` | `task_id`; marks the reviewed target stale before new work. Does not waive pending children. |
| `accept` | `task_id`; checks managed results and current review/court verdict. Root still examines scope, evidence and truth. No activation or deployment. |

Role definitions must match the bundled contracts, including aliases under other
filenames, so project overrides cannot quietly change tools or pin another model.
Concurrent writers need disjoint literal path ownership. This is a scheduling check,
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

Worker output is concise prose describing actual changes and checks. Reviewer and
adjudicator output is exactly one JSON object (one JSON fence is tolerated), matching
the supplied schema. Children cannot write report artifacts through their readonly
tools; root captures and validates returned bytes. Failed, malformed, interrupted or
stale results stay incomplete. No fixed review-attempt cap is imposed.

## Policy and evidence

Only the current Git root's `astraeus.toml` is read. Keys preserve Astraeus's format:
`schema_version`, `allowed_models`, `require_review_globs`, `assurance`.
The upstream model preferences remain; this user's current `openai/gpt-5.5` is also
explicitly authorized in the port's defaults. A bare ID in the allowlist restricts
IDs; it never chooses a provider. Actual dispatch always requires an exact available
provider/model and thinking level. No fuzzy matching, effort clamping, provider
substitution, API charging fallback, or account changes are used to recover.

Example for an explicitly selected local policy:

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
so saving them does not change target identity. Result/receipt hashes are checked again
at acceptance; adjudication binds to the exact original review bytes.

Workflow snapshots use Pi custom session entries and restore from the active branch,
not abandoned branches. Pi session identity controls ownership; there is no extra
session database. If a process restart loses a live Tintinweb child record, it is
shown as unavailable, never successful. Use Tintinweb's saved-session/@handle recovery
controls; managed continuation requires the original live record/session. Missing
review evidence requires a fresh review, not invented recovery. Artifacts are local
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
local deterministic provider. It never calls an external inference service or reads
personal auth. Set `PI_ASTRAEUS_SUBAGENTS` to a built/pinned Tintinweb package root to
qualify that exact source instead of the locked development npm package.
