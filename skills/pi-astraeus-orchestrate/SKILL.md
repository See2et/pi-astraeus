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

Choose capability first, then a supported thinking level. The automatic candidates are
GPT-6.1 Sol (`gpt-6.1-sol`), GPT-6 Luna (`gpt-6-luna`), and GPT-6 Astra (`gpt-6-astra`):

| Assignment | Preferred route |
| --- | --- |
| Root and ordinary worker | GPT-6.1 Sol medium; high for uncertain architecture, debugging, compatibility, concurrency, or costly errors. |
| Independent reviewer/adjudicator | Fresh GPT-6.1 Sol high when warranted. Fresh sessions provide independence; a different model is not required. |
| Narrow, easily checked work | GPT-6 Luna low/medium for localization, extraction, summarization, or explicit small edits with inexpensive objective checks. |
| Demanding or visual judgment | GPT-6 Astra high for deep reasoning, unresolved conflicting evidence, important architecture/security questions, or rendered visual acceptance. |

Keep ambiguous product/design decisions and high-impact acceptance off the cheap route.
Choose a stronger model upfront when warranted; there is no mandatory cheap-first ladder.
These are heuristics informed by the [adopted routing assessment](../../references/routing-proposal.md),
not measured quota savings or quality guarantees. Maximum thinking on a smaller model
does not replace capability. Only use thinking levels actually supported by Pi for the
exact selected model; do not clamp a requested level or silently change it.

Preserve exact explicit model/provider/thinking pins. Older GPT models, including
GPT-5.5, GPT-5.6 variants, and GPT-6 Sol, are excluded from automatic defaults but may
be authorized by project `astraeus.toml` `allowed_models` for explicit pins or measured
compatibility/latency exceptions. The saved Pi default is separately managed; this
package does not change it or claim to switch an already running root session.
Use actual Pi catalog entries and exact provider/model IDs at dispatch. Documentation
or an allowlist does not prove availability. If a preferred/pinned model is unavailable,
disclose it and obtain authorized configuration instead of substituting silently.
Never change authentication, billing routes, or use another inference CLI to recover.
Explain material routing changes. A root preference is not a runtime switch.

Only an explicit user request permits installed Claude Code background design direction and directly
related UI implementation. Read [Claude design delegation](../../references/claude-design.md)
before dispatch: record the original quote and scope once, use exact
`anthropic/claude-opus-5-5` with role `designer`, and keep follow-up fixes with that
owner in the same task. General implementation, review, adjudication and acceptance
stay on native GPT. This exception uses installed Claude Code `--bg`, CLI model
`claude-opus-5-5` and validated CLI effort, not Pi Anthropic credentials/catalog.
No auth changes, permission bypass or API/print fallback. GPT's narrowly authorized
runtime preflight sets only canonical `~/ghq` Git-root workspace trust before start/resume,
preserving all other config/auth/session values; outside that boundary trust stays manual.
Collect freezes the exact
observed UUID/cwd and records run-specific outcomes separately from acceptance.
Owned paths remain advisory assignment/scheduling like native GPT workers, not CLI
path permissions or baseline-delta gates; preserve user work and authorized design scope.
Failed collected runs may resume with verified original identity/freeze/evidence, without
a successful prior report. Resume without configuration overrides; reject copies.
Existing Claude sessions retain saved permissions; deployment does not migrate them.

Prioritize Astra for design direction and visual acceptance. For an authorized Claude
task, Opus owns design choices; GPT review assesses brief and function without
replacing its composition, typography, color or motion preferences. When appearance matters,
Astra must inspect rendered artifacts and relevant viewports/pages. A source review or
implementation report is not visual acceptance. Combine visual and independent review
when scopes fit. If Astra or visual access is unavailable, report the missing check.

## Handoff and acceptance

Use `astraeus_workflow` operations `start`, `status`, `delegate`, `collect`, `accept`,
and `invalidate`. Delegate with role `worker`, explicitly authorized `designer`, `reviewer`, or `adjudicator`, task ID,
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
