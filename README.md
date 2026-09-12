# capability-runtime

An LLM discovers a flow on a live application once. The run is frozen into a typed, versioned
**capability artifact**. That artifact then replays **deterministically, with no model in the
loop** — returning declared outputs, distinguishing legitimate business answers from real
failures, recovering from anticipated interruptions, and handing control to a human when it must
not proceed alone.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how an
> agent invokes it in production.

Design reasoning, trade-offs and cut lines: **[REPORT.md](./REPORT.md)**.

---

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
```

A model API key is needed **only** for the discovery run. Replay, the tests and every other demo
below run without one.

```bash
cp .env.example .env      # then set ANTHROPIC_API_KEY
```

The stand-in portal needs no credentials — it is a local mock with synthetic data. The service
sign-on the replay engine performs uses `PORTAL_USER` / `PORTAL_PASS`, which default to the mock's
throwaway values so nothing is required to run the demo.

---

## The target application

`app/` serves a deliberately hostile stand-in for a credit-union member-services portal: content
two frames deep, nested table layout, inline handlers, **no ids and no test hooks**, and inputs
whose only label is the text in the adjacent table cell. It is served under two tenant skins —
`tenant-a` (Northgate Credit Union) and `tenant-b` (Vale Mutual Savings) — from one codebase, which
is the shape of the real problem: many institutions running one vendor product.

All data is synthetic. No real members, balances or credentials.

```bash
npm run app        # http://localhost:5173
```

| Member  | Result when looked up                          |
| ------- | ---------------------------------------------- |
| `12345` | the happy path                                 |
| `10001` | another valid member                           |
| `55501` | flagged restricted → `ACCESS_RESTRICTED`       |
| `99999` | no such record → `MEMBER_NOT_FOUND`            |

---

## Demo path

**Leave `npm run app` running in another terminal for everything below.**

### 1. Discover a capability with a real LLM run

```bash
npm run discover -- --goal "Look up member 12345 and read their current savings balance"
```

The agent explores the portal, then records the flow cleanly, and the run is compiled into
`artifacts/member.read_savings_balance.json`. Options: `--entry <url>` for a different entry
point, `--headless`, `--provider cdp` to perceive through the browser's real accessibility tree
instead of the in-page projection, `--max-steps` / `--timeout-ms` (also `DISCOVERY_MAX_STEPS`,
`DISCOVERY_TIMEOUT_MS` in `.env`), and `--allow-risk irreversible` for a supervised recording of
a flow that submits something irreversible.

The run stops on one of five reasons — `goal_reached`, `max_steps`, `timeout`, `dead_end` (the
same action repeated, or the screen unchanged across several actions), or `model_declined` — and
exits non-zero for anything but the first.

Everything from the run lands in `evidence/discovery-<id>/` — the structured log, the full model
transcript, per-turn screenshots, and `recording.json`.

### 2. Replay it deterministically

```bash
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345
```

```
RESULT: SUCCESS
  outputs          {"savings_balance":18204.37}

  ✓ enter_the_member_identifier_in_the_lookup_form  proximity_label(textbox, "Member ID")
  ✓ submit_the_member_search                        role_name(button, "Search")
  ✓ open_the_matching_member_record_from_the_results role_name(link, "View")
  ✓ read_the_current_savings_balance_from_the_record proximity_label(cell, "Savings Balance")
```

No API key is used. The rightmost column is which rung of the locator cascade actually matched —
targeting degradation is reported, never silent. Every result also carries a **surface
fingerprint** comparison; a `drift` line appears when the screens the flow passed through have
changed shape since the recording.

```bash
# Same artifact, perceived through the browser's accessibility tree instead of the in-page scanner
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 --provider cdp
#   RESULT: SUCCESS — same four rungs, same fingerprint. Nothing above `Surface` knows which one ran.
```

Exit codes let a caller branch without parsing output: **0** success · **3** business outcome ·
**4** escalated · **1** failure.

### 3. Exercise the error paths

```bash
# A legitimate business answer, not a crash
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=99999
#   RESULT: BUSINESS_OUTCOME   code MEMBER_NOT_FOUND

# A different business answer, told apart from the one above
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=55501
#   RESULT: BUSINESS_OUTCOME   code ACCESS_RESTRICTED

# Rejected by the contract before a page is opened
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=abc
#   RESULT: FAILURE   kind invalid_input

# A blocking interstitial appears mid-flow and is recovered from
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 --inject interstitial
#   RESULT: SUCCESS   ↻ [recovered: MAINTENANCE_INTERSTITIAL]

# The session is dropped mid-flow: re-authenticate and restart the flow
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 --inject session_timeout
#   RESULT: SUCCESS   ↻ [recovered: SIGNED_OUT]   (earlier steps visibly re-run)

# A slow response, absorbed with no fixed sleep anywhere in the system
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 --inject slow
```

`--inject` arms a fault in the stand-in portal. It is a test-harness control plane
(`POST /__control`), not part of the modelled application.

### 4. Run the same artifact against a second institution

```bash
# Unspecialized against a new skin: fails, and names exactly what drifted
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 \
  --tenant tenant-b --no-overlay
#   RESULT: FAILURE   kind precondition_unmet
#   expected  text present: "Member Lookup"
#   remediation  If the tenant renamed this control, add a targetOverride to that tenant's overlay

# With a three-line tenant overlay: the same artifact, reused
npm run replay -- --artifact artifacts/member.read_savings_balance.json --input memberId=12345 \
  --tenant tenant-b
#   RESULT: SUCCESS   outputs {"savings_balance":18204.37}
#   ✓ ... proximity_label(textbox, "Member Number")
#   ✓ ... role_name(button, "Find Member")
```

The overlay is `artifacts/overlays/tenant-b.member.read_savings_balance.json`. It renames two
controls and one screen title, and binds the tenant's origin — the run header shows
`origin ... (bound from overlay tenant-b)`. The step sequence, checkpoints, business outcomes,
recoveries and extraction are reused unchanged.

### 5. Human handoff on an irreversible step

```bash
npm run demo:handoff
```

Scripted end-to-end: starts a shared browser session, replays a capability whose final step opens
an account, watches it refuse to proceed unattended, then posts the same form the operator
console's buttons post — claim control, authorize the step once, hand control back — and shows the
run resume and finish.

To drive it by hand instead, in four terminals:

```bash
npm run app                 # 1. the target application
npm run session             # 2. the shared browser — outlives every run
npm run operator            # 3. http://localhost:7788
npm run replay -- --artifact artifacts/member.open_sub_account.json \
  --input memberId=12345 --input accountType="Holiday Savings" --input openingDeposit=250.00
```

The run reaches the account-opening step, classifies it `irreversible`, raises an intervention and
**cedes the session**. Open the console: the request carries the step, the reason, a screenshot, a
redacted screen summary and the CDP endpoint of the live session. Take control — you are driving
the same window the automation was in, and the policy gate now blocks automation entirely. Then
either **Authorize this step** (automation performs it once) or **I did it myself** (automation
skips it). Control returns, the engine re-verifies the step's precondition, and the run completes.

### 6. Invoking a capability from an agent

```bash
npm run schema                                              # JSON Schema for artifact, overlay, result
npm run schema -- --tool artifacts/member.read_savings_balance.json
```

The second renders a capability as a tool definition another agent can be handed: declared inputs
become the parameter schema, declared outputs and business-outcome codes go in the description.
The programmatic half is `src/index.ts`:

```ts
import { toolDefinition, invoke } from './src/index.js';

const tool = toolDefinition(artifact);          // what the agent is shown
const result = await invoke({                   // what runs when it calls the tool
  artifact, inputs: { memberId: '12345' }, tenantId: 'tenant-b', baseUrl, overlay,
});
switch (result.status) {                        // what it gets back
  case 'success':          /* result.outputs.savings_balance */ break;
  case 'business_outcome': /* result.code === 'MEMBER_NOT_FOUND' */ break;
  case 'escalated':        /* result.interventionId, result.resumeToken */ break;
  case 'failure':          /* result.kind, expected, observed, screenshotPath */ break;
}
```

---

## Tests

```bash
npm test           # 79 tests; boots the app itself, no API key, no network
npm run test:unit  # the fast ones only (~0.3s)
npm run typecheck
```

Unit tests cover the locator cascade, redaction and the artifact leak guard, the policy gate, risk
classification, overlay merging, the checkpoint language, and the engine's handling of ambiguity,
recovery exhaustion, step timeouts and fingerprint drift. Browser-backed suites spawn the portal
and assert the behaviour the demo path shows — success and repeatability, both business outcomes,
input rejection, all three recovery paths, both perception providers, drift detection and overlay
reuse, human-action capture across frames and navigations during a handoff, and that regulated
values are absent from disk while still being returned to the caller. `test/discovery.test.ts`
drives the real discovery loop with a scripted fake model against the real portal — explore,
declare an outcome, record, compile, and replay the result to both success and `MEMBER_NOT_FOUND`
— so the core loop is tested end to end without an API key.

---

## Running without the model

```bash
npm run fixtures   # drive the flows from a fixed script → evidence/fixture-*/recording.json
npm run compile -- --recording evidence/fixture-read-balance/recording.json
```

`compile` rebuilds an artifact from a saved recording with no API call and no browser. It works on
a real discovery run's `recording.json` too — the artifact is a *derived* document, and being able
to regenerate it offline is both the proof that it is decoupled from the model transcript and the
reason iterating on locator strategy costs nothing.

The scripted fixtures exist so the **tests** need no model. The artifact in `evidence/` comes from
a real LLM run.

---

## Layout

```
app/                    stand-in portal: two tenants, injectable faults
profiles/portal.json    app profile — allowlist, recoveries, session establishment
src/schema/             the artifact, overlay, result and observation contracts (Zod)
src/surface/            Surface interface, browser implementation, the two perception
                        providers, and the locator cascade
src/policy/             redaction, risk classification, and the policy gate
src/agent/              the LLM loop, its tools, and the recording → artifact compiler
src/replay/             the deterministic engine, checkpoints, preflight, overlay merge
src/escalation/         session lifetime, control lease, intervention inbox, action capture
src/evidence/           structured run logs, screenshots, observation snapshots
src/cli/                app · session · discover · replay · operator · compile · schema
artifacts/              capability artifacts, tenant overlays, generated JSON Schema
evidence/               discovery and replay runs
```
