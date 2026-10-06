# Requirements and tests

Apply this to the affected behavior, not as a repository-wide audit on every task.
The user owns product scope. Root identifies the outcome, acceptance conditions,
non-goals, and preserved contracts in ordinary task context. Do not require a new
document, approval, provenance field on every old test, or separate audit agent.

Evidence for a contract can be the user's request, an agreed specification, an actual
consumer, a published API, or a data invariant. Existing implementation and tests show
what happens today, not automatically what must keep happening. Test counts, coverage
percentages, severity labels, and multiple agents agreeing do not establish user value.
Undocumented behavior can still have real consumers: absence of documentation alone
does not authorize deletion. Investigate concrete uncertainty in the affected area.

## During implementation

The same owner implements and verifies. When existing behavior or a failing test
constrains the requested change, distinguish:

- A preserved contract: fix the implementation and retain useful regression evidence.
- A behavior explicitly changed/retired by the authorized scope: update/remove its
  implementation, tests, and relevant documentation together.
- An implementation detail or redundant check: replace/remove only after accounting
  for its guarantee, diagnostic value, and independent regression protection.
- Unknown purpose or dependency: inspect relevant callers/history/usage, then return
  unresolved product choices to root. Unknown does not mean either immutable or disposable.

For each added test, identify the requirement or concrete failure it protects and the
gap in existing verification. Prefer the smallest adequate check in the existing design;
do not mirror implementation steps, enumerate speculative cases, or target test counts.
Boundary and error cases matter when supported by the contract or a concrete risk.
Types, schemas, integration checks, and regression examples can complement each other.

For changed/deleted tests, explain which behavior is intentionally retired or where
the still-required guarantee is verified instead. Group tests with the same rationale
when useful. Never weaken assertions merely to make a suite green; a test failure is
evidence to investigate, not automatic authority to restore the previous behavior.
Check that the actual guarantee survives, not just that a replacement test exists.

## Scope decisions

Complete routine implementation and verification autonomously inside the authorized
scope. Return a concise product decision only if proceeding would add/remove user
behavior, alter a promised external contract, or require a data transition that the
user has not authorized. Present the affected users/data, evidence, and smallest options;
do not ask the user to adjudicate individual test cases or ordinary implementation choices.

For already tangled areas, propose a bounded cleanup with concrete behavior/dependency
evidence and a removal boundary. A broad cleanup is separate authorized work; discovery
during a feature task does not authorize purging legacy behavior across the repository.
