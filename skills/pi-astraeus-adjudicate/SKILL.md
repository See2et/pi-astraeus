---
name: pi-astraeus-adjudicate
description: Decide which independent review findings warrant action before fixes or acceptance under Astraeus. Assess requirement authority, concrete impact, and proportionality; do not implement fixes.
---

# Review adjudication

Root dispatches a fresh Pi child agent distinct from the implementer and reviewer after
a complete independent review returns `changes_required`. A `pass` goes directly to
root acceptance after validation; incomplete or `inconclusive` reviews need evidence
or the next review round, not adjudication. Read [policy](../../references/policy.md),
[contracts](../../references/contracts.md), and [requirements and tests](../../references/requirements-and-tests.md).
Use the orchestrate routing guidance; consequential product/design judgment favors
Astra. No implementation conversation or proposed adoption verdict is inherited.

Supply the original request, authorized scope/non-goals, preserved contracts and their
evidence, exact stable target, relevant artifacts, verification results, and the original
review JSON. Identify changed/deleted tests and their stated rationale when applicable.
The agent may inspect dependencies to test claims, but does not repeat the whole review,
rerun routine verification, edit through any tool, or spawn agents. Disclose unavailable
read-only/schema enforcement; use the same assurance rules as review, with a separate
host receipt for each role when strict assurance is required.

## Decide, do not inherit

For every review item, check the authority of the claimed requirement, concrete affected
behavior and evidence, and the proportionality of the proposed remedy. Code, existing
tests, reviewer confidence, severity labels, and test counts alone are not requirement
authority. Inspect material claims independently. A test can reproduce current behavior
without proving it should be preserved. Apply the requirements-and-tests guidance to
both new verification and changed/removed tests; do not dismiss a real defect because
the user did not enumerate that exact failure.

Return one disposition per review item:

| Action | Meaning |
| --- | --- |
| `fix` | A concrete defect or contract violation within authorized scope warrants correction. State the required outcome, not an unnecessarily broad reviewer solution. |
| `investigate` | A concrete concern needs bounded evidence before deciding. State the missing fact. |
| `reject` | Not warranted for this task: unsupported requirement, optional improvement, redundant verification, or disproven claim. Explain why using evidence; absence of documentation alone is insufficient. |
| `human_decision` | A material product scope/contract change needs authority the current request does not supply. Give evidence and small options. |

Use the adjudication JSON contract, binding it to the exact review bytes and target.
Do not manufacture findings to justify the role. `accept` means all review items are
rejected with reasons (or there were none), review coverage/evidence are complete, and
no unknowns remain. An accepted `fix` means `changes_required`, not final acceptance;
`investigate`, `human_decision`, or unresolved evidence means `inconclusive`.
A complete `changes_required` review can be rejected on evidence and lead to `accept`.
An incomplete/inconclusive review cannot be waived into acceptance.

## Root integration and finite recovery

Root validates the contract against the original review and current target, then checks
the evidence and disposition. Only adopted fixes go to the original implementation
owner for implementation and ordinary verification. Resolve investigations in that same
ownership; escalate only unauthorized product decisions, grouped for the user. Neither
adjudicator nor root may silently change the agreed requirements to obtain acceptance.

Follow the review budget in policy: one adjudicator dispatch per complete `changes_required` review,
at most two total, no hidden repair turns or adjudication of adjudication. Failures and
inconclusive results consume the allocated attempt. A corrected target or new evidence
needs the next review/adjudication round within the remaining budget. A material new
defect found during adjudication must be recorded as unresolved (and sent for correction
or the next review), not inserted as an unbound review item or silently accepted.
Unresolved disagreement, exhausted budget, stale artifacts, or missing evidence remains
incomplete. Root owns final acceptance and reports limits; JSON validation is not proof
that the findings or rationale are true.

## Pi dispatch

Use `astraeus_workflow` with `op: "delegate"` and the corresponding role, then
`op: "collect"` to obtain the child result. Root chooses an exact provider/model ID
from Pi’s live model catalog and an authorized supported thinking level. Child roles
use isolated fresh sessions; do not invoke a separate inference CLI. The currently
provided Pi runner has no enforced read-only sandbox: reported assurance discloses
that limitation; strict assurance stops before dispatch. Instructions to avoid edits
are not permission enforcement. Root validates the JSON result through the bundled
validator and rechecks the source target before `op: "accept"`.
