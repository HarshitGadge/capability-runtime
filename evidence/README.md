# Evidence

One directory per run. Each holds `run.jsonl` (append-only structured log), `result.json` or
`artifact.json` (the exact contract produced), `screenshots/`, and `observations/` — structured
snapshots of the perceived screen, the surface-agnostic equivalent of a DOM dump.

Everything here is redacted on the way out. Pattern-matched values (account numbers, balances)
appear as `«account:…»` / `«currency:…»`. Values a capability *declares* regulated (a member name,
a confirmation number) are additionally scrubbed by declaration once the run's artifact exists, so
they appear as `«withheld:member_name»` even where no regex would have caught them. The real value
is returned to the caller in process and is nowhere on disk. The only literal member data you will
find under `evidence/` is in this file, which names the tokens in prose.

## Discovery runs — a real LLM driving the live surface

All three were driven by `claude-opus-5` against the stand-in portal. The artifact each produced is a
*derived* document: `npm run compile -- --recording <dir>/recording.json` regenerates it with no
API call, which is how the artifact is decoupled from the transcript rather than a copy of it.

| Directory | Goal | Turns | Cost | Outcome |
| --- | --- | --- | --- | --- |
| `discovery-10c45c2c` | Look up member 12345 and read their savings balance | 14 | ~$0.32 | `goal_reached` — 7 steps, 4 outputs, `MEMBER_NOT_FOUND` |
| `discovery-35f9938e` | Open a Holiday Savings sub-account and reach confirmation | 27 | ~$1.08 | `goal_reached` — 11 steps, an `irreversible` step, `MEMBER_NOT_FOUND` + `DEPOSIT_BELOW_MINIMUM` |
| `discovery-ac02212f` | Post a $50 transfer from savings and reach confirmation | 32 | ~$1.47 | `goal_reached` — 12 steps, an `irreversible` confirm, `MEMBER_NOT_FOUND` + `INSUFFICIENT_FUNDS` |

Each contains `transcript.json` (the full model transcript) and `recording.json`. Reading a run in
order shows the two-phase loop: the model reaches the goal, then goes back and probes an invalid
member ID to learn the failure screen, declares the outcome from what it saw, and only then records
the flow cleanly. The balance run's `provenance.notes` records the two reviewer decisions applied at
compile time — `member_name` raised to regulated, and `ACCESS_RESTRICTED` declared as an outcome the
model never encountered.

Two earlier attempts are not kept but are worth knowing about. A sub-account run stopped at
`max_steps` because a harness bug (the test reset endpoint clearing *all* sessions) kept signing the
model out mid-flow — the model coped, re-authenticating each time, but ran out of budget; the bug
is fixed. And the first transfer run was **declined by the model** (`stop_reason: refusal`) — a funds
transfer with no context read as potential fraud. The loop handled it as the `model_declined` stop
reason rather than crashing; adding truthful context to the discovery prompt (a sandboxed
evaluation, synthetic data, an authorized operator task) resolved it. Both are the kind of thing
only a real run surfaces.

## Replay runs — deterministic, no model

| Directory | Command | Result |
| --- | --- | --- |
| `replay-15d05505` | `--input member_id=12345` | **SUCCESS** — four outputs; every step at the top rung — **and a real drift report**: recorded before the "Transfer Funds" link was added to the member screen, so every `/member` step reports `5 → 6` controls. The capability still works; the reviewer is told exactly where the app changed |
| `replay-43a2863f` | `--input member_id=99999` | **BUSINESS_OUTCOME** `MEMBER_NOT_FOUND` — the app answered; a result, not a crash |
| `replay-f23d6fc0` | `--input member_id=55501` | **BUSINESS_OUTCOME** `ACCESS_RESTRICTED` — the reviewer-declared outcome, recognised on screen |
| `replay-4fedd5c3` | `--inject interstitial` | **SUCCESS** with `↻ MAINTENANCE_INTERSTITIAL` — banner dismissed, postcondition re-verified rather than the action repeated |
| `replay-79836596` | `--inject session_timeout` | **SUCCESS** with `↻ SIGNED_OUT` — session dropped mid-run, re-authenticated, flow restarted, repeated steps visible in the trace |
| `replay-4946ff75` | `--provider cdp` | **SUCCESS** through the browser's real accessibility tree — same rungs, and the *same* drift report step for step: the fingerprint measures the app, not the perception provider |
| `replay-605b914f` | `--tenant tenant-b --no-overlay` | **FAILURE** `precondition_unmet` — the unspecialized capability meets a second institution's skin and names the exact literal that drifted |
| `replay-14ac84ae` | `--tenant tenant-b` | **SUCCESS** — the same artifact on the second institution via a three-line overlay |
| `replay-0ddc31e7` | transfer `--input amount=99999.00` | **BUSINESS_OUTCOME** `INSUFFICIENT_FUNDS` — declared by the model after probing it during discovery |
| `replay-250de059` | transfer `--input amount=5000.00` | **ESCALATED** after `↻ HIGH_VALUE_CONFIRM` — an **unexpected confirmation dialog** the recording never saw is handled as a recovery, then the irreversible confirm routes to a human |
| `replay-9c2c1ab0` | transfer `--tenant tenant-b` | **ESCALATED** at confirm — the transfer capability reused on the second institution with the same three-line overlay pattern |
| `replay-c248c1db` | `npm run demo:handoff` | **SUCCESS** after human escalation — see below |
| `replay-c3acc487` | `npm run demo:handoff -- --deposit 10` | **BUSINESS_OUTCOME** `DEPOSIT_BELOW_MINIMUM` — the human approved the step and the app rejected it; approval is not success |

## The escalation run

`replay-c248c1db` is the full handoff loop from `npm run demo:handoff`. Reading `run.jsonl` in order:

```
confirmation_required   the sub-account submit step is classified irreversible, above the ceiling
escalation_raised       intervention filed with the step, the reason, a screenshot, and the CDP
                        endpoint of the live session
control_ceded           lease flips to `human`; the policy gate now refuses every automation action
note                    operator authorized one execution of this step
control_returned        lease returns to automation with a new token
step_succeeded          the engine re-verified the precondition, then performed the authorized step
run_finished            status success, confirmation number returned (as «withheld» on disk)
```

Running it as `npm run demo:handoff -- --deposit 10` instead has the human-approved step rejected by
the app's own validation, and the run returns `DEPOSIT_BELOW_MINIMUM` — a human approving a step is
not the same as the step succeeding.

## Agent-driven invocation

`agent-demo.md` is the transcript of `npm run agent`: a real LLM given the capabilities as tools
and a natural-language task, choosing which to call, with deterministic replay running underneath.
It relays a missing member as `MEMBER_NOT_FOUND` — a plain answer, not an error — because the tool
contract told it that outcome is a result.

## Fixture recordings

`fixture-read-balance/` and `fixture-open-subaccount/` are **scripted** recordings, not model runs.
They exist so the test suite needs no API key, and they are what `test/discovery.test.ts` and the
`npm run compile` demo build from. They carry the same declaration scrub as a real run, so no
`recording.json` in the repo holds member data.
