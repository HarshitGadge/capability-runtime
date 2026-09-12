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

Both were driven by `claude-opus-5` against the stand-in portal. The artifact each produced is a
*derived* document: `npm run compile -- --recording <dir>/recording.json` regenerates it with no
API call, which is how the artifact is decoupled from the transcript rather than a copy of it.

| Directory | Goal | Turns | Cost | Outcome |
| --- | --- | --- | --- | --- |
| `discovery-10c45c2c` | Look up member 12345 and read their savings balance | 14 | ~$0.32 | `goal_reached` — 7 steps, 4 outputs, `MEMBER_NOT_FOUND` |
| `discovery-35f9938e` | Open a Holiday Savings sub-account and reach confirmation | 27 | ~$1.08 | `goal_reached` — 11 steps, an `irreversible` step, `MEMBER_NOT_FOUND` + `DEPOSIT_BELOW_MINIMUM` |

Each contains `transcript.json` (the full model transcript) and `recording.json`. Reading a run in
order shows the two-phase loop: the model reaches the goal, then goes back and probes an invalid
member ID to learn the failure screen, declares the outcome from what it saw, and only then records
the flow cleanly. The balance run's `provenance.notes` records the two reviewer decisions applied at
compile time — `member_name` raised to regulated, and `ACCESS_RESTRICTED` declared as an outcome the
model never encountered.

The sub-account run stopped once at `max_steps` before this one; that transcript is not kept, but
the stop-reason machinery it exercised is covered in `test/discovery.test.ts`.

## Replay runs — deterministic, no model

| Directory | Command | Result |
| --- | --- | --- |
| `replay-baca7fe9` | `--input member_id=12345` | **SUCCESS** — four outputs; every step at the top rung of its cascade |
| `replay-45f4098d` | `--input member_id=99999` | **BUSINESS_OUTCOME** `MEMBER_NOT_FOUND` — the app answered; a result, not a crash |
| `replay-e9b90c5a` | `--input member_id=55501` | **BUSINESS_OUTCOME** `ACCESS_RESTRICTED` — the reviewer-declared outcome, recognised on screen |
| `replay-cd67e074` | `--inject interstitial` | **SUCCESS** with `↻ MAINTENANCE_INTERSTITIAL` — banner dismissed, postcondition re-verified rather than the action repeated |
| `replay-5154932b` | `--inject session_timeout` | **SUCCESS** with `↻ SIGNED_OUT` — session dropped mid-run, re-authenticated, flow restarted, repeated steps visible in the trace |
| `replay-ff500f4a` | `--provider cdp` | **SUCCESS** through the browser's real accessibility tree — same four rungs, same surface fingerprint; nothing above `Surface` knows which provider ran |
| `replay-6bc271c1` | `--tenant tenant-b --no-overlay` | **FAILURE** `precondition_unmet` — the unspecialized capability meets a second institution's skin and names the exact literal that drifted, plus the remediation |
| `replay-84a33ec9` | `--tenant tenant-b` | **SUCCESS** — the same artifact on the second institution via a three-line overlay; the trace shows `proximity_label(textbox, "Member Number")` |
| `replay-64a01eb4` | `npm run demo:handoff` | **SUCCESS** after human escalation — see below |

## The escalation run

`replay-64a01eb4` is the full handoff loop from `npm run demo:handoff`. Reading `run.jsonl` in order:

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

## Fixture recordings

`fixture-read-balance/` and `fixture-open-subaccount/` are **scripted** recordings, not model runs.
They exist so the test suite needs no API key, and they are what `test/discovery.test.ts` and the
`npm run compile` demo build from. They carry the same declaration scrub as a real run, so no
`recording.json` in the repo holds member data.
