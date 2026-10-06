---
name: pi-astraeus-review
description: Conduct an explicitly requested independent review, or the required acceptance review of consequential changes under Astraeus. Do not review trivial work by ritual or fix findings as the reviewer.
---

# Independent review

Root remains the final acceptance owner; a separate adjudicator decides which findings
warrant action before fixes or acceptance. Read [policy](../../references/policy.md) and
[contracts](../../references/contracts.md). Start after implementation and ordinary
verification, against an identified stable target including relevant untracked files.

Use a fresh Pi child agent with no implementation conversation. Provide the original
requirements, constraints, exact target, relevant code, and verification evidence.
Do not prime the reviewer with the implementer's confidence or proposed verdict.
Focus on requirements, behavior put at risk by the change, and gaps in verification.
The handoff should identify affected behavior and risk areas without prescribing
findings; the reviewer independently checks coverage and may inspect beyond the diff
for dependencies or risks the handoff missed. Do not request unrelated improvement
searches or redesign. Reuse ordinary verification evidence unless a concrete concern
or evidence gap requires a targeted check; independence requires independent judgment,
not routine repetition of the implementer's tests.

Choose model/effort using the orchestrate routing guidance; difficult design or visual
judgment favors Astra. Tell the reviewer: do not edit files, implement fixes, or spawn
agents. Read-only is an instruction unless host permissions demonstrably enforce it.
Explicitly include any unavailable read-only enforcement or generation-time schema
enforcement in the review prompt. Default `reported` assurance permits these disclosed
limitations. `strict` requires host evidence for the requested model/effort and read-only
sandbox; otherwise stop the affected review. A read-only shell sandbox does not prove
MCP/connector operations are read-only: prohibit mutations through every tool.

Use [requirements and tests](../../references/requirements-and-tests.md) when assessing
existing behavior or verification. Identify the source of a claimed requirement and
concrete impact in each finding's evidence. Tests and code alone are not authority to
preserve behavior; inspect changed/deleted tests for retired contracts or replacement
guarantees. Missing speculative test cases are not bugs. Actual data, security, or
consumer failures still matter even when the request did not enumerate them.

Return the review JSON contract. Separate requirement violations and concrete bugs
from optional improvements. Every blocking finding needs a location, concrete claim,
and evidence/reproduction. Do not turn preferences into bugs. Use `inconclusive` for
missing evidence or incomplete coverage, never a speculative pass.

Root validates the reply and checks evidence against the current target. For a complete
`pass`, validate with `--kind review --accept` and proceed to root acceptance without
an adjudicator; optional suggestions do not trigger adjudication or block acceptance.
Dispatch [adjudication](../pi-astraeus-adjudicate/SKILL.md) only for a complete `changes_required`
review, before adopting fixes or accepting the rejected target. Do not automatically
send findings to the implementer. Reviewer `pass` is not final acceptance; root still
checks scope, evidence, assurance, and target identity. Pass is not required when
complete findings are rejected on evidence by the adjudicator. Incomplete coverage/evidence cannot be waived. A process exit code or a
well-formed reply alone is not acceptance. Review existing user changes only to the
extent required to assess the authorized change, and never claim credit for them.

An incomplete or `inconclusive` review needs evidence or the next review round,
not adjudication.

There is no fixed total dispatch limit. Retry failed, interrupted, or malformed attempts
as needed; incomplete or inconclusive results need evidence or another review. For adopted fixes, the original
implementation owner edits and verifies; a fresh reviewer checks the accumulated target with emphasis on
fixed issues and affected behavior. A renewed prompt may include prior findings as
issues to verify, without asserting their resolution. Do not repeat unrelated checks.

Root may change unpinned models with a reason within the same requirements.
Never expand permissions, change billing routes, or widen scope to recover. If the
evidence is missing, review/adjudication disagree unresolvedly, or the
target changed after review, report incomplete and the precise next decision needed.
Continue authorized corrections and reviews as needed; attempt count alone does not
require user continuation or justify acceptance.

## Pi dispatch

Use `astraeus_workflow` with `op: "delegate"` and the corresponding role, then
`op: "collect"` to obtain the child result. Root chooses an exact provider/model ID
from Pi’s live model catalog and an authorized supported thinking level. Child roles
use isolated fresh sessions; do not invoke a separate inference CLI. The currently
provided Pi runner has no enforced read-only sandbox: reported assurance discloses
that limitation; strict assurance stops before dispatch. Instructions to avoid edits
are not permission enforcement. Root validates the JSON result through the bundled
validator and rechecks the source target before `op: "accept"`.
