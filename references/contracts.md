# Output contracts

Contracts describe results, never the agent's private reasoning or search sequence.
Read only the relevant schema under `../schemas/`. Review and adjudication require JSON; exploration,
research, and implementation may use concise prose when parsing offers little value.
Empty lists are valid where there is nothing to report. Do not manufacture findings.

Common fields: `schema_version: 1`, `kind`, `task_id`, `target_id`, `status`
(`complete|blocked|failed`), and a short `summary`.

| Kind | Additional fields |
| --- | --- |
| exploration | `locations`, `findings`, `evidence`, `unresolved` |
| research | `conclusions`, `sources` (URL, applicable version, checked date, support), `uncertainties` |
| implementation | `changed_files`, `checks` (command, outcome, evidence), `remaining` |
| review | `verdict`, `violations`, `bugs`, `suggestions`, `checked_scope`, `evidence`, `unresolved` |
| adjudication | `verdict`, `review_sha256`, `decisions`, `checked_scope`, `evidence`, `unresolved` |

Review findings contain `location`, `claim`, `evidence`. Suggestions are short strings.
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
target. A complete `changes_required` review needs adjudication; an incomplete or
`inconclusive` review needs evidence or the next review round. Strict review acceptance
requires the reviewer host receipt via `--receipt`. Review v1 files remain valid inputs.
For other roles omit `--accept`;
inspect status and evidence before integration. No `--accept` means format/semantic
validation only (exit 0 does NOT mean acceptance).

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
