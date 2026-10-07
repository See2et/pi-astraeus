# Policy and host boundaries

Astraeus is an instruction layer, not a scheduler or security boundary. Pi owns
native GPT execution, authentication, threads, permissions, and model capabilities.
Explicit designers use installed Claude Code background execution and its existing auth. Skill use
cannot guarantee that the host will always obey policy or load all instructions.

Project `astraeus.toml` is optional. Read only the file at the working project root.
Validate via `python3 <package>/scripts/astraeus.py doctor --config astraeus.toml`.
Defaults: GPT-6.1 Sol, GPT-6 Luna, and GPT-6 Astra; no additional mandatory
paths; assurance=reported. Reviews and adjudications have no fixed total count limit.
The former `review_limit` setting is retired; remove it from existing project configs.
Allowed model IDs are restrictions, not proof of availability.
`require_review_globs` matches project-relative changed paths with Python fnmatchcase
semantics (`*` can cross `/`); these add review requirements, never remove risk-based ones.
Load the Pi skills and extension through the authorized Pi package configuration.
Do not edit global configuration or install anything during ordinary project work.

Only a complete `changes_required` review triggers one separate fresh adjudicator
before fixes or acceptance of the rejected target. A complete `pass` goes directly to
root acceptance after review validation and current-target/evidence checks; optional
suggestions do not trigger adjudication. Incomplete or `inconclusive` reviews need
evidence or the next review round, not adjudication. Use one adjudicator per complete
`changes_required` review; do not create reviewer/adjudicator debate loops or recursive
acceptance agents. Failed, malformed, or interrupted attempts may be retried. Continue
with corrected artifacts or new evidence as needed, without requesting user continuation
solely because of an attempt count. Repeat checks only for a concrete issue or evidence
gap; unresolved work remains incomplete.
Trivial work that needs no independent review needs no adjudicator.

Reviewer findings are proposals, not authorized requirements. Root checks an independent
adjudicator's dispositions; only adopted fixes return to the original implementation
owner. The user retains product scope authority. An adjudicator can reject unsupported
claims, but cannot waive incomplete review coverage or invent approval to retire a
real contract. See [adjudication](../skills/pi-astraeus-adjudicate/SKILL.md) and
[requirements and tests](requirements-and-tests.md) for decision criteria.

Use the extension's `astraeus_workflow` tool for start/status, delegate/collect,
accept, and invalidate operations. Root remains the routing and acceptance owner.
Workers retain implementation and ordinary verification. Reviewers and adjudicators
start fresh without implementation conversation and must not edit via any tool.
Use the actual Pi model catalog and supported thinking capabilities. Always dispatch
an exact provider/model ID; a bare ID in allowed_models is a restriction, not permission
to invent a provider. If preferred routes are unavailable, obtain an authorized
model pin or project policy; never silently substitute models. Legacy GPT pins remain
valid when explicitly authorized by project `allowed_models`; they are excluded from
automatic defaults. Fresh same-model review remains independent.
No external inference CLI for GPT recovery, alternate authentication engine, or charging
fallback. The explicit designer transport below is a user-authorized route, not recovery.
Pi's current child runner does not enforce a read-only sandbox. Strict assurance must
stop before review/adjudication; reported assurance may proceed with clear disclosure.
A tool denial or model mismatch cannot be repaired by expanding permissions or silently
switching models.

Log requested model/effort and host-observed values separately. When host confirmation
is absent, use unknown, with a short source explanation. Do not inspect auth files,
private session history, unrelated personal skills, or billing to fill missing values.
Under reported assurance, unobservable realized settings can proceed with disclosure;
known mismatch cannot be called a successful pinned dispatch. Under strict assurance,
missing evidence is blocking. No silent model substitution, unauthorized external inference, or
API charging fallback. User pins remain authoritative.

Review target IDs can be supplied by a caller's immutable snapshot or by the bundled
`target` command. The command hashes HEAD, tracked staged/unstaged changes, and
nonignored untracked files. Keep outputs in ignored `.astraeus/`; otherwise writing
the result changes the target. It does not hash ignored build outputs, dependency
state, or external services. Freeze concurrent writers while identifying/reviewing
a target; recheck identity before acceptance. Visual evidence must identify the
rendered artifact and relevant viewports/pages, not merely point to source code.

Record task ID, target ID, selected reviewer/adjudicator,
the original review's content hash, and results in ordinary
task context. If context compaction would lose this, save a short local note under
ignored `.astraeus/`. No mandatory ledger for solo work and no custom authentication/session engine.
The checker binds adjudication to the exact supplied review and checks disposition
coverage and acceptance consistency. It does not authenticate rationale, host receipts,
role independence, or discover consequential changes: root checks those.

The [explicit Claude design exception](claude-design.md) uses installed Claude Code
`--bg` only for a recorded user-requested designer scope, logically pinned to exact
`anthropic/claude-opus-5-5` (CLI model `claude-opus-5-5`). It does not modify regular GPT
allowed_models or require Pi Anthropic availability. General workers/reviewers/adjudicators
remain native and reject Anthropic. Managed ownership and review freezing remain;
CLI stop/launch evidence and run-bound reports supplement source-target checks.
No API/print fallback, auth modification, installation or permission bypass is allowed.
