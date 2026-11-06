# Output contracts

Contracts describe results, never the agent's private reasoning or search sequence.
Read only the relevant schema under `../schemas/`. Review and adjudication require JSON; exploration,
research, and implementation may use concise prose when parsing offers little value.
Empty lists are valid where there is nothing to report. Do not manufacture findings.
The Claude Code designer transport requires implementation JSON, including `run_id`
equal to this run and `target_id` equal to its dispatch baseline. It writes only the
run-specific pending path; root stops the exact UUID/cwd writer and publishes original
schema/binding-validated bytes as an outcome, including unsuccessful work. Complete status,
passed required commands and no remaining work are success prerequisites, not prerequisites
to recording the outcome or resuming a failed original frozen owner for correction.
`changed_files` reports the owner's edits, not exact attribution against shared-cwd deltas.
Absent requested checks means `checks: []`, never fabricated checks. Collection is
post-validation, not generation-time schema enforcement or final acceptance.

Common fields: `schema_version: 1`, `kind`, `task_id`, `target_id`, `status`
(`complete|blocked|failed`), and a short `summary`.

| Kind | Additional fields |
| --- | --- |
| exploration | `locations`, `findings`, `evidence`, `unresolved` |
| research | `conclusions`, `sources` (URL, applicable version, checked date, support), `uncertainties` |
| implementation | `changed_files`, `checks` (command, outcome, evidence), `remaining` |
| review | `verdict`, `violations`, `bugs`, `suggestions`, `checked_scope`, `evidence`, `unresolved` |
| adjudication | `verdict`, `review_sha256`, `decisions`, `checked_scope`, `evidence`, `unresolved` |

Review findings contain `location`, `claim`, `evidence`, and optionally `prior_decision`
(the task-scoped saved disposition ID for the same finding, even with new wording/ID).
Existing v1 reports without links remain valid; unmapped blocking claims remain blocking.
Suggestions are short strings.
`verdict` is `pass|changes_required|inconclusive`. Missing evidence/coverage or unresolved
questions require inconclusive. A valid changes_required/inconclusive reply is useful
data, not acceptance. The implementer returns what actually ran, including failures.
Research sources must support the attached claim; a URL's existence is not proof.

Adjudication decisions have `ref`, `action`, `basis`, `evidence`, and `rationale`.
`ref` addresses the original review's array and zero-based index, e.g. `bugs/0`.
Every item of `violations`, `bugs`, `suggestions`, and `unresolved` must be covered
exactly once; no invented or duplicate references. `basis` states the requirement's
authority or why it is not warranted. `action` is `fix|investigate|reject|human_decision`.
Bind `review_sha256` to `sha256:` followed by the hex SHA-256 of the exact review file
bytes (compute with Python hashlib or a system SHA-256 tool; do not guess the hash).
Preserve original review files; edited findings require a new adjudication.

The adjudication verdict is `accept|changes_required|inconclusive`. `accept` requires
complete status, scope/evidence, no unresolved matters, and only rejected findings
(or no findings). Source review must be complete with scope/evidence, not inconclusive,
and have no unresolved matters. `changes_required` requires adopted fixes and no pending
investigations/human decisions. Pending decisions or evidence make it `inconclusive`.
A complete review's `changes_required` may lead to adjudication `accept` if every claim
is rejected on evidence. Validators check consistency, not the truth of this judgment.

Pi child execution has no generation-time schema-enforcement capability. Put the relevant shape in
the prompt, state that enforcement is unavailable when it is, and validate the return:

```sh
python3 <package>/scripts/astraeus.py validate-result .astraeus/result.json \
  --kind review --task-id task-1 --target-id <current-target> --accept

python3 <package>/scripts/astraeus.py validate-result .astraeus/adjudication.json \
  --kind adjudication --task-id task-1 --target-id <current-target> \
  --review-result .astraeus/result.json --accept
```

Install `jsonschema>=4.23,<5` in the selected Python environment, or use
`uv run <package>/scripts/astraeus.py` to resolve the declared validator dependency.
Neither path installs a model runtime.
`--review-result` is required for adjudication, even without `--accept`.
`--accept` supports review and adjudication. A review must be a complete `pass` with
scope/evidence and no blocking or unresolved items; optional suggestions are allowed.
Root may accept that target without adjudication after checking the evidence and current
target. The standalone validator is stateless: `--accept` on `changes_required` still
requires an accepting adjudication. The managed workflow also supports explicit
root dispositions bound to source bytes/run/ref/target, permitting clear bounded fixes
to owner assessment and reject/optional-only acceptance after root checks. Disputed
scope/evidence/interpretation requires independent adjudication; incomplete or
`inconclusive` review needs evidence or the next review round. Strict review acceptance
requires the reviewer host receipt via `--receipt`. Review v1 files remain valid inputs.
For other roles omit `--accept`;
inspect status and evidence before integration. No `--accept` means format/semantic
validation only (exit 0 does NOT mean acceptance).

Managed `disposition` takes `run_id`, `ref`, `action: adopt|reject|optional`,
`route: clear|disputed`, `authority`, `rationale`, `evidence`; persisted entries include
stable identity, source review hash and target. `prior_decision` explicitly maps a
repeated finding, including a root-supplied mapping missed by the reviewer. For an older
unmapped blocker, `prior_finding: "<review-run>/bugs/N"` (or `violations/N`) maps a current
report item to that exact saved source; no old-target restoration or invented prior
decision is required. Do not combine it with `prior_decision`. Both reports' original
bytes/receipts remain bound and checked. Reopening reject/optional, whether by adoption
or disputed routing, requires `reopening` describing concrete new evidence/relevant
code change and distinct supporting evidence, not a new ID/wording/severity/target hash.
Root judges substance; the tool checks trace/binding, not arbitrary semantic equivalence.
Adjudication results are imported transactionally into the same history, preserving their
source binding. History is inherited by fresh reviews and owner follow-ups; it cannot
waive coverage or silently accept unmapped/adopted/disputed blockers. An unresolved
blocker (including unmapped or adopted claims) survives a later pass that omits it.
Reject/optional dispositions resolve claims explicitly. Otherwise, owner dispatch binds
`assessed_decisions` to exact adopted decision IDs (or source-run/ref for legacy v1
adjudication fixes); a collected successful owner report with assessment/check evidence
and a subsequent fresh complete review are required. Reopening cannot reuse an earlier
owner run's assessment. Root verifies the report's substance. Legacy state without this
owner binding stays conservative and can use explicit current-report dispositions.

Individual adjudication dispositions do not waive report-level pending matters. A retained
complete adjudication with an inconclusive verdict, unresolved matters, or missing
coverage/evidence remains an acceptance obligation, including legacy v1 results. Its
`<adjudication-run>/report` token is assigned through the existing owner-assessment
binding; collect supported assessment/refutation/correction and verification evidence,
then obtain a fresh complete review of that evidence. Evidence-only recovery need not
change code. Fresh reviewers receive the bound reports and reported owner evidence.
A later pass, disposition override or omission alone cannot discharge the report; its
original bytes/receipt remain checked after resolution. No history or useful individual
decision is discarded. Root judges whether the supplied evidence actually resolves the
matter within authorized scope. `delegate` adjudicator may
select its original review via `run_id` if that reviewed target is still current; if
source changed, obtain a fresh complete review linking the disputed claim first.
`status(task_id, run_id, ref)` narrows omitted job/disposition history without changing it.

The host receipt is separate from the child's contract. A child must not invent
runtime confirmation. Strict adjudication requires `--assurance strict --receipt`
for the adjudicator and `--review-receipt` for the reviewer, each with JSON shaped as:

```json
{"requested":{"model":"openai/gpt-6-astra","effort":"high"},
 "observed":{"model":"openai/gpt-6-astra","effort":"high","sandbox":"read-only"},
 "source":"host metadata: actual thread/tool response reference"}
```

The checker verifies consistency of supplied data; it cannot authenticate the receipt.
Root must obtain it from the host, never fabricate it or accept child self-report.
Do not collect extra telemetry merely to fill a receipt under reported assurance.
Root also verifies the agents are distinct and
the target and original review are still current. No receipt proves those by itself.

Pi uses `thinking` in its tool contract; validator receipt `effort` remains the stable
v1 field and holds that selected thinking value. A host-selected model/thinking value
is dispatch evidence, not proof of an enforced sandbox. This Pi port currently reports
sandbox as unknown and rejects strict review/adjudication dispatch. Never manufacture
a `read-only` receipt from a prompt or from omitting write tools.
