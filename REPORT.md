# Design write-up

An LLM discovers a flow on a live application once. The run is frozen into a typed, versioned
**capability artifact**. The artifact then replays with **no model in the loop**, returning
declared outputs and distinguishing three things production actually throws at it: business
answers the caller did not want, interruptions that can be handled, and situations that need a
person.

The target is a self-built, deliberately hostile legacy portal — content two frames deep, nested
table layout, no ids or test hooks, inputs whose only label is the text in the adjacent cell —
served under two tenant skins. Built rather than borrowed because it is the only way to trigger
every condition in §3.3 deterministically, on demand, and under a second institution's branding.

## 1. Architecture

```
Surface (interface)      observe() → Observation · resolve(target) · click/type/select/press/navigate
 ├─ BrowserSurface       finds semantically; acts through real mouse and key events
 │   ├─ DomScanProvider  in-page accessibility projection (default)
 │   └─ CdpAxProvider    the browser's real accessibility tree
 └─ PolicyGate           decorator: allowlist · risk ceiling · redaction · control lease

Discovery  LLM loop → recording.json → compiler → CapabilityArtifact (Zod, semver)
Replay     artifact + inputs → Success | BusinessOutcome | Failure | Escalated
Escalation lease + inbox + operator console, over a browser session that outlives the runner
Evidence   JSONL + screenshots + observation snapshots, redacted on the way out
```

**Perception is accessibility-shaped, not DOM-shaped.** Nothing above `Surface` mentions a
browser, a selector or markup. Everything is written against `UiElement { role, name, value,
proximityLabel, bounds, frame }` — the same tuple Windows UIA or macOS AX produces. The interface
has no `evaluate()` escape hatch; if a capability needed one the abstraction would be a lie.

**Two perception providers, because a seam nobody has crossed is a claim.** `--provider cdp`
replays the same artifact through `Accessibility.getFullAXTree` — same four rungs, same
fingerprint. It did not start that way: a raw AX tree gives a bare legacy input no accessible
name, and the first run through it degraded to `ordinal` at step one and failed at step three
(the trace said exactly that). The fix was to derive "the label in the cell to the left" from the
tree's own row/cell structure — what UIA's Table pattern would give a desktop provider — rather
than from the DOM. The lower rungs of the cascade stay, because the next surface will lack
something else.

**The policy gate is a decorator, not a checklist.** Discovery and replay both hold a
`PolicyGate` and neither holds the surface beneath it. There is no code path that can act while
bypassing policy. A guardrail you have to remember to call is not a guardrail.

**The model decides what to do; the runtime decides how to find it again.** The model picks
controls by reference number from a rendered screen. The compiler derives targeting from the
element it actually touched and keeps only strategies it can verify uniquely matched that element
on the recorded screen. A locator that was already ambiguous at record time is discarded, not
shipped as a latent flake.

**Exploration and recording are separate phases.** The agent's first pass through an unfamiliar
UI is full of back-tracking. It explores, then calls `start_recording`, the session resets, and it
performs the flow once cleanly. Only the second pass becomes steps.

**Trade-off:** one process, files instead of a database, no queue. The control lease is three
fields that would become a row with a TTL; the inbox is a directory that would become a table.
None of that is built, per the brief. `src/index.ts` exposes the two calls an agent host needs —
`toolDefinition(artifact)` for what the agent is shown, `invoke(...)` for what runs when it calls.

## 2. Artifact schema

Zod in `src/schema/` yields the validator, the TypeScript types and the JSON Schema from one
definition. `npm run schema -- --tool <artifact>` renders a capability as a tool definition:
declared inputs become the parameter schema; declared outputs and business-outcome codes go in
the description. That is the payoff of a typed contract over a step list.

```
CapabilityArtifact
  capability        id · semver · description       ← what a calling agent reads
  target            appId · appVersion · surface · entryPoint · allowlist
  inputs[]          name · type · pattern · sensitivity · example
  outputs[]         name · type · sensitivity · required
  steps[]           intent · action · target · risk · precondition · postcondition · timeoutMs
  success           Checkpoint
  businessOutcomes  code · detect:Checkpoint          ← expected non-success results
  recoveries        code · detect · actions · maxAttempts · then · escalateOnExhaustion
  provenance        model · run · tenant · evidence · surfaceFingerprint
```

**Targets are ranked strategy lists.** `role_name → proximity_label → placeholder → text →
ordinal → coordinates`, with an optional scope and frame path. The top rungs describe what a
control *means* and survive restyling, DOM reordering and tenant skinning; the bottom rungs
describe where it was and survive almost nothing. Replay stops at the first rung that matches and
**records which one won**, so degradation is a visible signal, never a silent flake.
`proximity_label` is not a convenience: this portal's member-ID input has no accessible name at
all. Coordinates are recorded but never choose an element on their own. `ambiguity` says what to
do with more than one match: fail, take the first, or escalate.

**Scopes make row selection stable.** `row_containing: {input: memberId}` means "the View link in
the row for the member we asked about". `ordinal[2]` means "the third one", true until the result
set changes.

**Business outcomes are declared.** "No such member" is an answer the caller asked for, not an
exception. The artifact carries the detector; replay recognises it by what is on screen and
returns `{status:'business_outcome', code:'MEMBER_NOT_FOUND'}`.

**Values are typed references** — `input | extracted | const | secret` — so a reviewer sees which
values the caller supplies and which come from the environment. Credentials are `secret`,
resolved from env at run time, never in the document.

**Deliberately absent:** screenshot hashes, DOM-shape assertions, embedded code. Checkpoints are a
small declarative assertion language, evaluable with no model and no `eval`, reviewable by someone
who does not read TypeScript.

## 3. Determinism & error handling

Replay imports no model client. **One waiting primitive:** poll until a stated checkpoint holds
or time out naming the clause that never became true. No fixed sleeps, no `networkidle`. A slow
surface and a broken one are then distinguishable, which is the difference between a retry and a
failure. Each step also carries a wall-clock `timeoutMs` around the action itself.

**Per-step proof.** Each step has a precondition and postcondition generated from the recorded
screens. Two subtleties surfaced. On a frameset the top URL never changes, so `url_matches`
evaluates against every frame. And "first heading on the page" picks the navigation menu, which is
identical on every screen and asserts nothing — the compiler instead identifies the working frame
as the one whose content varies across the recording.

**The classification order is the whole difficulty.** After every step:

1. **Declared business outcome?** Terminate and report it — checked *first*, before any retry.
   Checking it last is the common bug: the engine burns its retry budget on a screen that is
   clearly saying there is no such member.
2. **Declared recovery condition?** Remediate within that rule's budget, then **re-verify the
   postcondition before redoing anything**. Dismissing an interstitial usually reveals the screen
   the step wanted; repeating the action there is a duplicate submission waiting to happen. A rule
   whose budget is exhausted either escalates (`escalateOnExhaustion`) or fails.
3. **Postcondition holds?** Continue.
4. **Otherwise:** hard failure with step, expected, observed, remediation hint, screenshot and
   observation snapshot.

The result is a discriminated union — `success | business_outcome | failure | escalated` — with
exit codes 0/3/4/1 so a caller branches without parsing text. Every arm reports which locator
rung each step used and a **surface fingerprint** comparison: the sequence of screen shapes the
flow passed through, `drifted: true|false`, or `null` when the run stopped before every screen
was seen — a guess would be worse than an honest "not judged".

**Recovery policy is per rule, and `then` matters.** A maintenance banner is `retry_step`. A
dropped session is `restart_flow`, because the result set the blocked step expected died with the
session. Restart is refused once an irreversible step has executed: replaying a transfer because
the session dropped afterwards is worse than failing.

**Sign-on is an app-level concern, not a step.** Recording it into each capability makes the
capability unrepeatable when a session already exists and bakes one institution's credentials into
a shared document. It lives once, in the app profile, and the same `SIGNED_OUT` rule is the
preflight before a run and the handler mid-flow.

**Discovery has its own stopping conditions:** max steps, wall-clock timeout, and dead-end
detection (the same action repeated, or the screen unchanged across several actions), each
reported as a distinct stop reason.

## 4. Heterogeneity & multi-tenant

**Other surfaces.** A UIA provider fills the same `UiElement` from `ControlType`, `Name`,
`LabeledBy` and `BoundingRectangle`; macOS AX from `AXRole`/`AXTitle`/`AXFrame`. The schema does
not change — `frame: string[]` becomes a window/pane path, `role` takes that platform's vocabulary
— and the engine, checkpoint language, gate and escalation model are untouched. The CDP provider
is the evidence the seam holds. What *would* need work is acting (a native dropdown is not a
`<select>`), which is exactly why acting lives behind the interface while finding does not.

**Many tenants, one product.** Artifacts are keyed to the **vendor product**, never a tenant.
Specialization is a separate `TenantOverlay` that may retarget a control by `semanticId`, remap
screen wording in checkpoints, add tenant-only recoveries, and bind the tenant's origin — and may
**not** add, remove or reorder steps, change the success condition, or widen the allowlist. If
overlays could change the flow, a year later there are N forks nobody can review or upgrade
together. A tenant that runs a genuinely different flow is a different capability version.

Demonstrated, not described: the capability recorded against Northgate runs unchanged against
Vale Mutual — different palette, fonts, reordered result columns — with a **three-line overlay**:
two renamed controls and one reworded title. Steps, checkpoints, outcomes, recoveries and
extraction are reused.

**Drift detection**, cheapest first. Run the unspecialized artifact against a new tenant: the
failure names the exact literal that moved and points at the overlay. The surface fingerprint in
every result flags a capability for re-review when the screens it passed through changed shape.
And the locator rung in every trace is the leading indicator: a fleet-wide slide from `role_name`
to `ordinal` on one capability means that product shipped a release, before anything breaks.

## 5. Escalation & handoff

**Detecting stuck** is four explicit triggers, not one heuristic: the risk ceiling
(`ConfirmationRequired` from the gate); a target with `ambiguity: escalate` resolving to more than
one element; a recovery rule exhausting its budget with `escalateOnExhaustion`; and, during
discovery, the dead-end detector. Plain locator misses and postcondition failures do **not** page
a human — a broken artifact is an engineering problem, and routing every miss to an operator queue
is how the queue gets ignored.

**The structural requirement is session lifetime.** If the runner owned the browser, "let a
human take control of the live session" would be impossible — the window dies with the stuck
process. `npm run session` starts the browser as its own process; every run attaches over CDP.
Automation exits while the session, cookies, scroll position and half-filled form stay put.

**Control is an explicit fact.** A single-writer lease records who holds the session. The gate
checks it before *every* action, so a person taking over mid-step is not fighting an automation
still clicking. Control returns with a new token, so a killed-and-restarted runner cannot
resurrect itself into a session someone is now using.

**The loop.** Escalate → file an `InterventionRequest` carrying capability, step and intent, the
reason, a redacted screen summary, a screenshot, an observation snapshot and **the CDP endpoint of
the live session** → lease flips to `human` → the operator claims it and works in the same window
→ they **authorize one execution** of the blocked step, or say they did it themselves → lease
returns → automation **re-observes and re-proves the step's precondition** before acting. If the
operator left the session somewhere unexpected, that is a precondition failure, not a click on
whatever now occupies those coordinates.

Authorization is single-use and step-scoped: approving "open this sub-account now" is not
approving every one for the rest of the run. While the human holds the lease, page listeners
record what they clicked, changed and submitted into the same evidence stream — an intervention is
evidence of a gap, and it is the most informative event the system produces.

**Mocked:** the console's presentation — one auto-refreshing page, no video, no auth, no SLA.
**Real:** the request and its context, the lease, the transfer, the blocking of automation, the
capture of the human's actions, single-use authorization, and the verified resume.
`npm run demo:handoff` runs the loop end to end and ends in `SUCCESS`.

## 6. Safety

**Allowlist at one chokepoint.** Origins, path prefixes, action verbs and a maximum unattended
risk class, enforced in the gate both paths act through. The URL is re-checked *after* every
action, because a click can navigate and an allowlist that only guards `navigate` is escaped by
any link. Origins are a tenant binding, supplied by the overlay — a reviewed document — not a
runtime flag.

**Risk is a property of the step, not the verb.** Clicking "Search" and clicking "Confirm
transfer" are the same verb. The recorder proposes a class from the control's semantics —
conservatively, since a false positive costs one confirmation and a false negative moves money —
writes it into the artifact where a reviewer can raise it, and policy decides what each class may
do. Above the ceiling the default is to **route to a human, not block**; irreversible steps are
never retried.

**Redaction happens on the read path.** The model never sees a balance or account number; it sees
`«currency:25fe2a»`. A system that shows the model a balance and then scrubs the log has still
disclosed it. Tokens are stable within a run and reversible **in process only**, so the runtime
can type a value back into the page and return the real number to the caller while the evidence
keeps the token.

**Declared sensitivity outranks pattern matching.** A regex cannot recognise a balance that was
normalized to `18204.37`. Outputs the artifact declares `regulated` are masked in evidence by
their *declaration* — `«withheld:currency»` — while the real value is returned in process. This
was a live leak found by grepping the evidence directory, and it is the clearest illustration of
why pattern redaction is a backstop and typed sensitivity is the control.

**Artifacts are guarded twice.** The compiler will not build a locator or checkpoint from a
literal that looks regulated, equals a caller-supplied value, or is a redaction token, and
`assertNoRegulatedData` re-scans the finished document and fails the build. It caught the compiler
emitting `text: "$18,204.37"` as a locator during development.

**Limits.** Regex over rendered text misses a balance rendered as an image, and the currency
threshold ($1,000, so "minimum $25.00" survives) is a configuration choice. Risk classification
from labels is a weak signal, which is why it is reviewable rather than load-bearing. The
allowlist trusts the URL the browser reports. And nothing here defends against a malicious
*target*: a page that renders instructions to the agent is a prompt-injection surface this system
does not address.

## 7. Cuts

**Not built, on purpose.** Queues, workers, a tenant registry, any distribution — the brief
penalizes it and it would be the least interesting code here. A desktop provider: the seam is
argued in §4 and the CDP provider shows swapping perception changes nothing above `Surface`, but
no UIA code exists. A co-browsing console. Self-healing locators — when targeting degrades the
system says so loudly rather than re-running a model to rewrite the artifact in production.
Generalizing from a single recording. Auth on the operator console (localhost only).

**Next, in order.** (1) Record the same flow against two tenants and diff: literals that differ
are tenant-specific and belong in overlays automatically. (2) A registry keyed on the surface
fingerprint, so "which capabilities on which tenants are degrading" is a query, not an incident.
(3) Promote repeated interventions into recovery rules — the operator's actions are already in the
evidence stream. (4) A UIA provider against a real desktop app, the honest test of §4.
