# Routing proposal — 2026-10-06

This is a researched proposal, not an applied default or a change to the user's Pi
settings. Preserve explicit model/provider/thinking pins. The actual local Pi saved
selection initially observed on this date was `openai/gpt-5.5`. The user subsequently
authorized setting the saved default to `openai/gpt-6.1-sol` with `medium` thinking;
that settings change was verified while preserving every unrelated setting. An
already running session is not claimed to have switched models. Pi's offline catalog lists all three
proposed GPT-6 IDs and `anthropic/claude-opus-5-5`; catalog presence does not establish
account access, quota, provider readiness, or the billing route.

## Verified rates relevant to the current routing pool

Standard speed, USD per 1M tokens, input up to 272K. API columns are input / cached
input / output. Credit columns are Codex/ChatGPT Work input / cached input / output
per 1M tokens. Credit billing has no separate cache-write charge. These are published
rates, not an account-specific subscription-consumption multiplier.

| Model | API USD | Codex/Work credits |
|---|---|---|
| GPT-6.1 Sol | 2 / 0.10 / 10 | 50 / 2.5 / 250 |
| GPT-6 Luna | 0.10 / 0.01 / 0.50 | 2.5 / 0.25 / 12.5 |
| GPT-6 Astra | 10 / 1 / 50 | 250 / 25 / 1250 |
| GPT-6 Sol | 2 / 0.20 / 10 | 50 / 5 / 250 |
| GPT-5.6 Sol | 4 / 0.40 / 20 | 100 / 10 / 500 |
| GPT-5.6 Terra | 2 / 0.20 / 12 | 50 / 5 / 300 |
| GPT-5.6 Luna | 0.20 / 0.02 / 1.20 | 5 / 0.5 / 30 |
| GPT-5.5 | 5 / 0.50 / 30 | 125 / 12.5 / 750 |

Sources checked 2026-10-06:
- [API pricing](https://developers.openai.com/api/docs/pricing)
- [Sol 6.1](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Luna 6](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Astra 6](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Sol 6](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [Sol 5.6](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Terra 5.6](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Luna 5.6](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)
- [Codex/Work credit and subscription pricing](https://learn.chatgpt.com/docs/pricing)

Older models are not all more expensive than 6.1 Sol: 5.6 Luna is cheaper per token
than 6.1 Sol, but 6 Luna is cheaper than 5.6 Luna. 5.4 Mini is 0.75 / 0.075 / 4.50 and
5.4 Nano is 0.20 / 0.02 / 1.25, both cheaper than Sol 6.1 and more expensive than Luna 6
in token rates. These comparisons do not prove quality or cost per successful task.
Sources: [5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
[5.4 Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano).

For equal noncached input/output token counts, 5.6 Sol is 2x the API/credit rate of
6.1 Sol. Terra has equal input, 2x cached input and 1.2x output. 6 Sol has equal input/
output but 2x cached input. Astra costs 5x Sol 6.1 for noncached input/output and 10x
cached input, so use it for difficult judgment rather than every independent reviewer.
Luna 6 costs 1/20 Sol 6.1 for noncached input/output and 1/10 cached input. GPT-5.5 costs
2.5x noncached input, 5x cached input and 3x output compared with 6.1 Sol.

API cache-write tokens are billed at 1.25x the uncached input rate for the GPT-6 models.
Long-context premiums, speed modes, tool charges and regional processing may change
actual API cost. Reasoning tokens, extra turns and correction work change task totals;
per-token dominance is not a measured quality/latency dominance.

## Proposed policy

- Root: GPT-6.1 Sol medium; high for uncertain architecture, difficult coordination or
  costly errors. Do tightly coupled/simple work at root rather than spawning by ritual.
- Ordinary worker: GPT-6.1 Sol medium; high for debugging, compatibility, concurrency or
  multi-component behavior. Keep implementation, normal verification and fixes together.
- Independent reviewer/adjudicator: fresh GPT-6.1 Sol high when warranted. Independent
  sessions provide independent judgment; a different model is not a prerequisite.
- Bounded cheap subtask: GPT-6 Luna low/medium for source localization, extraction,
  summarization, explicit small edits with an inexpensive objective acceptance check.
  Do not delegate ambiguous product/design decisions or high-impact acceptance to it.
- Demanding judgment: GPT-6 Astra high for unresolved conflicting evidence, important
  security/concurrency/architecture questions, and visual acceptance of rendered work.
  Choose it upfront when requirements warrant it, not a mandatory cheap-first ladder.
- Explicitly requested Claude design: Pi-native exact Anthropic Opus 5.5+; Claude owns
  design direction and directly related UI work. GPT retains independent review,
  adjudication and final acceptance. User choices and actual functional constraints
  outrank every model's taste. No design request means no automatic Anthropic dispatch.
- Older GPT models: keep exact user pins and measured compatibility/latency exceptions;
  remove them from normal automatic candidates if this proposal is adopted. No silent
  substitution if a selected provider/model is unavailable or a quota is exhausted.

These are recommendations inferred from documented capability categories and rates,
not benchmark results on this repository. Official selection guidance recommends Luna
for scoped efficient work, Sol 6.1 for complex cost-conscious work, and Astra for the
most demanding reasoning. [Model selection](https://developers.openai.com/api/docs/guides/model-selection)

Sol 6.1 supports low/medium/high/xhigh/max, not none/minimal. Luna 6 also supports none;
only use levels the actual host reports. Standard is the default cost-conscious speed;
Fast uses 2x purchased-credit/API rates and 2.5x included subscription usage where
available. Astra Ultrafast uses 6x purchased-credit/API and 8x included usage. These are
billing multipliers, not speed guarantees. Do not enable speed tiers as a fallback.

## Subscription interpretation and local verification limits

Published token credits apply to purchased credits/eligible credit agreements. They
are not fixed coefficients for an individual's included Pro allowance. Official
included-use estimates vary by task, context and speed, and pricing explicitly warns
against converting API dollars or credit rates into included tasks. No billing data,
account quota dashboard, personal auth contents or real paid inference was queried.

GPT-5.5 retires from ChatGPT/Work/Codex on 2026-10-14; API access is unaffected. A Pi
`openai/gpt-5.5` selection alone does not establish whether that retirement affects its
actual authentication/billing path. Verify the sign-in route before changing it.
[Official plan pricing and retirement notice](https://learn.chatgpt.com/docs/pricing)
