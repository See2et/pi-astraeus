# Upstream provenance

This Pi port derives from [See2et/astraeus](https://github.com/See2et/astraeus),
MIT licensed, copyright 2026 See2et. The policy and validator source is the installed, root-flake-locked plugin at
revision `c8f80d02b5416a779afce6a59cbe7c6088bdbb2c`. `LICENSE` retains its notice.

The five JSON Schemas derive from upstream; implementation adds an optional `run_id`
for the Claude transport, where the workflow requires exact run binding. The Python result validator, Git target
identity algorithm, requirements-and-tests guidance, and review/adjudication policy
are derived from `plugins/astraeus/`. Regression fixtures and core validator tests
are derived from upstream examples/tests in the editable checkout at
`a4700effa3c24677e510caabe062b5738b60ac53`, adapted to current policy. Schemas and receipt field names remain v1.

Pi adaptations remove Codex activation and plugin maintenance commands, add read-only
`policy --repo` and `matches-review --repo` bridge commands, replace host-specific
routing guidance and skill names, and integrate Pi workflow delegation. The upstream
model list is replaced by the user's adopted 2026-10-06 routing policy: GPT-6.1 Sol,
GPT-6 Luna, and GPT-6 Astra. Older GPT candidates are excluded from automatic defaults;
exact legacy pins remain available through explicit project `allowed_models`. The
researched rates and adoption status are recorded in `references/routing-proposal.md`.
This policy change does not alter Pi settings or authentication. Native GPT dispatch
uses the actual catalog and exact provider/model IDs; the explicitly authorized designer
now uses installed Claude Code `--bg` with exact `claude-opus-5-5` and existing CLI auth.
The background short-ID/full-UUID binding, retained launch/stop evidence and root-owned
pending-result finalization adapt the read-only upstream `claude_bridge.py` reference;
Pi deliberately retains current-cwd managed ownership rather than its linked-worktree API;
 strict assurance remains blocked until
real sandbox evidence exists. The retired `review_limit` is rejected with a migration message; reviews and
adjudications have no fixed dispatch count cap. No installation or activation side effects are part
of the Python bridge.
