---
name: pi-astraeus-orchestrate
description: Apply Astraeus policy to authorized project work in Pi. Keep simple tasks solo, delegate only useful bounded work, and independently review consequential changes before root acceptance.
---

# Astraeus orchestration in Pi

The user owns product intent and scope. Root owns architecture, routing, integration,
and final acceptance. Do trivial work directly: no ritual plan, agent, contract, or
receipt. Do not expand the task. For consequential work, read
[policy](../../references/policy.md) and only the project root's explicit `astraeus.toml`.
The bundled `policy --repo ROOT` command validates that file or returns defaults;
never search parents or personal skills. User constraints and host permissions prevail.

For behavior changes establish outcome, acceptance conditions, non-goals, and preserved
contracts from the request and relevant evidence. Clear requests need no extra approval
or permanent spec. Read [requirements and tests](../../references/requirements-and-tests.md)
when existing behavior/tests constrain the change or verification changes. Code, tests,
and suggestions describe current behavior; they do not authorize requirements.

Delegate only with a bounded outcome, adequate context, disjoint ownership, and acceptance
check, where benefit exceeds handoff/integration cost. Keep coupled architecture at root.
Once the handoff is ready, stop root discovery. Keep discovery, implementation, ordinary
verification, and follow-up fixes with one owner; do not split agents merely by phase or
ask children to delegate. Preserve user changes. Root checks the diff and evidence;
repeat checks only for integration changes, failed checks, missing evidence, or a named
concrete concern, limited to affected scope.

## Routing

Choose capability first, then a supported thinking level. Preserve explicit model and
thinking pins. Upstream preferences are GPT-6.1 Sol for root, GPT-6 Astra for deep
independent or visual judgment, GPT-5.6 Sol for complex dependencies or costly errors,
GPT-5.6 Terra for bounded ordinary judgment, and GPT-5.6 Luna for narrow easily checked
work. GPT-6 Luna is not a default candidate. These are heuristics, not measured quota
savings or guarantees. Maximum thinking on a smaller model does not replace capability.

Use actual Pi catalog entries and exact provider/model IDs at dispatch. Documentation
or an allowlist does not prove availability. The current user's `openai/gpt-5.5` setup
is explicitly authorized and included in this port's defaults; it does not establish
Astra availability or judgment. If a preferred/pinned model is unavailable, disclose it
and obtain authorized configuration instead of substituting silently. Never change
authentication, billing routes, or use another inference CLI to recover. Explain material
routing changes. A root preference is not a runtime switch; never claim an unobserved one.

Prioritize Astra for design direction and visual acceptance. When appearance matters,
Astra must inspect rendered artifacts and relevant viewports/pages. A source review or
implementation report is not visual acceptance. Combine visual and independent review
when scopes fit. If Astra or visual access is unavailable, report the missing check.

## Handoff and acceptance

Use `astraeus_workflow` operations `start`, `status`, `delegate`, `collect`, `accept`,
and `invalidate`. Delegate with role `worker`, `reviewer`, or `adjudicator`, task ID,
exact model, supported thinking value, and bounded prompt. Announce requested model/thinking
and one-line reason first. Supply goal, ownership, constraints, acceptance evidence, and
useful output contract. Give children fresh context by default. Reviews and adjudications
must not inherit implementation conversation or a proposed verdict.

For consequential behavior/API/compatibility, data, permissions, installation, or
meaningful multi-component changes, run [independent review](../pi-astraeus-review/SKILL.md)
after ordinary verification. Mandatory project path globs add requirements, never remove
risk-based ones. Root decides borderline cases with a short reason. Trivial spelling/format
edits can remain solo; optional polish adds no acceptance gate.

Only a complete `changes_required` review triggers one separate fresh
[adjudicator](../pi-astraeus-adjudicate/SKILL.md) before adopting fixes or accepting the
rejected target. Complete `pass` goes to root acceptance after validation and current
source/evidence checks. Optional suggestions do not trigger adjudication. Incomplete or
`inconclusive` review needs evidence or the next review round; adjudication cannot waive
coverage. The original implementation owner makes adopted fixes and verifies them.

Reviews and adjudications have no fixed total dispatch limit. Use one separate fresh
adjudicator per complete `changes_required` review. Retry malformed, interrupted, or
failed attempts as needed; incomplete or inconclusive results need evidence or another
review. No reviewer/adjudicator debate loops or recursive acceptance agents. Continue
authorized corrections and reviews without requesting user continuation solely because
of an attempt count. Repeat checks only for a concrete issue or evidence gap; unresolved
work remains incomplete.

Read [contracts](../../references/contracts.md) for structured results; review and
adjudication always return exact JSON. Validate schemas and acceptance semantics,
bind task/target and original review hash, and recheck source identity before acceptance.
Keep state/results in ignored `.astraeus/`; freeze concurrent writers while reviewing.
Changed source invalidates old review evidence. Validation does not establish truth,
independence, permissions, or final acceptance; root checks those separately.

Pi's current runner has no enforced read-only sandbox or generation-time JSON guarantee.
Reported assurance discloses these limitations. Strict assurance stops review/adjudication
before dispatch without actual host evidence for model/thinking and a read-only sandbox.
Prompt instructions and omitted tools are not a real sandbox. Never fabricate receipts.
Keep requested settings distinct from host evidence; unknown remains unknown. Use only
already available cost observations; do not query billing or estimate quota savings.
