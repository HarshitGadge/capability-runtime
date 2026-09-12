# Evidence

One directory per run. Each contains `run.jsonl` (append-only structured log), `result.json`
(the exact contract returned to the caller, including the locator rung per step and the surface
fingerprint comparison), `screenshots/`, and `observations/` — structured snapshots of the
perceived screen, which are the surface-agnostic equivalent of a DOM dump.

Everything written here passes through the redactor first. Regulated values appear in the logs as
stable tokens (`«currency:…»`, `«account:…»`) even though the same run returns the real value to
its caller in process.

Declared outputs get a second, stronger control. A pattern-based redactor over free text cannot
catch everything — a balance normalized to the number `18204.37` no longer looks like currency to a
regex — so outputs the artifact declares `regulated` are masked in the logs by their *declaration*
and appear as `«withheld:currency»`. `result.json` is the caller's own return value and holds the
real number; `run.jsonl` never does.

## Replay runs

| Directory | Command | Result |
| --- | --- | --- |
| `replay-1b7e2b0a` | `--input memberId=12345` | **SUCCESS** — the declared `savings_balance` output, every step resolved at the top rung of its locator cascade |
| `replay-751a1bf4` | `--input memberId=99999` | **BUSINESS_OUTCOME** `MEMBER_NOT_FOUND` — the app answered, and the answer is a result the caller asked for, not a crash |
| `replay-65c8bd90` | `--input memberId=12345 --inject interstitial` | **SUCCESS** with `↻ [recovered: MAINTENANCE_INTERSTITIAL]` — a blocking notice appeared mid-flow, was dismissed, and the postcondition was re-verified rather than the action repeated |
| `replay-7e6583e0` | `--input memberId=12345 --inject session_timeout` | **SUCCESS** with `↻ [recovered: SIGNED_OUT]` — the session was dropped mid-run; the engine re-authenticated and restarted the flow, with the repeated steps visible in the trace |
| `replay-60652909` | `--tenant tenant-b --no-overlay` | **FAILURE** `precondition_unmet` — the unspecialized capability meets a second institution's skin and reports the exact literal that drifted, plus the remediation |
| `replay-cabb1b0a` | `--tenant tenant-b` | **SUCCESS** — the same artifact on the second institution via a three-line overlay; the trace shows `proximity_label(textbox, "Member Number")` and `role_name(button, "Find Member")` |
| `replay-15b06d97` | `--input memberId=12345 --provider cdp` | **SUCCESS** through the browser's real accessibility tree instead of the in-page scanner — same four locator rungs, same surface fingerprint; nothing above `Surface` knows which provider ran |
| `replay-0a1d00c2` | `npm run demo:handoff` | **SUCCESS** after human escalation — see below |

## The escalation run

`replay-0a1d00c2` is the full human-handoff loop, produced by `npm run demo:handoff`. Reading
`run.jsonl` in order:

```
confirmation_required   step classified irreversible, above the unattended ceiling
escalation_raised       intervention filed with the step, the reason, a screenshot and the
                        CDP endpoint of the live session
control_ceded           lease flips to `human`; the policy gate now refuses every automation action
note                    operator authorized one execution of this step
control_returned        lease returns to automation with a new token
step_succeeded          the engine re-verified the precondition, then performed the authorized step
run_finished            status success, confirmation number returned
```

`screenshots/` contains the frame the operator was shown at the moment of escalation.

## Fixture recordings

`fixture-read-balance/` and `fixture-open-subaccount/` are **scripted** recordings, not model runs.
They exist so the test suite needs no API key, and they are what `npm run compile` rebuilds the
committed artifacts from. They are in the same `recording.json` shape a discovery run produces,
which is how that path stays honest.

## Discovery run

A genuine LLM-driven discovery run against the live surface lands in `discovery-<id>/`, containing
the same structured log plus `transcript.json` (the full model transcript) and `recording.json`
(the compiled-from recording). The artifact is a *derived* document: `npm run compile -- --recording
evidence/discovery-<id>/recording.json` regenerates it with no API call, which is the demonstration
that the artifact is decoupled from the transcript rather than a copy of it.
