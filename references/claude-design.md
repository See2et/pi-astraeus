# Explicit Claude design delegation in Pi

Only an explicit user request for Claude permits this exception. Login to Anthropic,
a generic appearance request, or a model catalog entry alone is not authorization.
Record the original user quote in `design_request` and bounded `design_scope` at
`start`, or once with `authorize_design` for an existing task. Allowed scope labels
are `design-direction`, `ui-implementation` (directly related to the authorized
design), and `design-direction-and-ui-implementation`. Each designer dispatch must
repeat the recorded scope label. That authorization persists through the same task's
follow-up fixes; a new task requires its own request. Do not broaden it for unrelated
business logic. Root must verify the original explicit user request and interpret
whether each assignment and follow-up fits its scope.

These fields are caller attestations, not authenticated user consent. A root model
can supply arbitrary quoted text. Labels and prompt contracts do not semantically
classify assignments or enforce a filesystem sandbox. Do not describe these gates
as proof of genuine consent or a guarantee of scope enforcement.

Use role `designer` with exact `anthropic/claude-opus-5-5`. This is the currently
qualified minimum Opus 5.5 route; no older Opus, Sonnet, Haiku, alternate provider,
fuzzy matching, or availability fallback is permitted. Newer models require an
explicit supported integration update. Do not add Anthropic to general allowed_models:
worker, reviewer and adjudicator routes reject Anthropic even if allowlisted.
The scoped designer exception is separate from regular GPT policy restrictions.
Pi owns its existing Anthropic authentication and provider; this package never reads
authentication files or starts another inference runtime.

## Design handoff

The Opus owner keeps discovery, design direction, directly related UI implementation,
ordinary verification, and adopted fixes together. Preserve its composition,
typography, color and motion decisions unless an explicit user requirement or a
functional constraint requires a change. Return adopted fixes to the original live
owner through `resume`; do not replace it with a GPT implementer. Lost owner sessions
use the existing Tintinweb recovery path, not a new owner launched as a fallback.

Independent review, adjudication and root acceptance stay on GPT, with fresh review
and adjudication sessions. Reviewers assess the user brief, contracts, usable behavior
and relevant rendered artifacts. They do not substitute their aesthetic preferences
for Opus's choices. Findings need a concrete requirement or functional constraint;
optional taste suggestions do not become adopted fixes. Astra remains preferred for
rendered visual acceptance; missing Astra or render access must be disclosed.

## Host boundary

This is Pi-native Anthropic delegation through the existing Tintinweb native session
API, not the upstream Claude Code CLI bridge. It uses the same repository working
directory as other managed Pi writers. No dedicated linked worktree, Claude Code
snapshot, CLI ownership checker, or worktree sandbox is provided or claimed.
Managed literal disjoint path ownership, cross-task writer freezing, stable target
hashes, native host receipts and branch-aware lifecycle remain the baseline. These
are scheduling and evidence checks, not OS isolation. The designer definition has
worker tools and `extensions: false`; review/adjudication retain built-in read-only
tools, and strict assurance stays blocked without host-attested OS isolation.
