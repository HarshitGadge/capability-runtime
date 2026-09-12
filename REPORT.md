# Design write-up

A system that lets an LLM discover a flow on a live application once, freezes it as a typed
capability artifact, and then executes that artifact deterministically — no model in the loop —
with explicit handling for the things that actually go wrong in production: business answers you
did not want, interruptions you can recover from, and situations that need a person.

The stand-in target is a deliberately hostile legacy portal (frames, nested table layout, no test
IDs, controls whose only label is the text in the adjacent cell) served under two tenant skins.
It was built rather than borrowed because it is the only way to trigger the failure taxonomy in
§3.3 — not-found, permission denial, validation error, blocking interstitial, session timeout,
slow load — deterministically and on demand.

---

## 1. Architecture

One process, five modules, one chokepoint.

```
Surface (interface)         observe() → Observation | resolve(target) | click/type/select/press/navigate
  └─ BrowserSurface         finds semantically, acts through real input events
       ├─ DomScanProvider   in-page a11y projection (default)
       └─ CdpAxProvider     the browser's real accessibility tree
  └─ PolicyGate             ← decorator: allowlist, risk ceiling, redaction, control lease

Discovery   LLM loop ──────▶ recording.json ──▶ compiler ──▶ CapabilityArtifact (Zod, versioned)
Replay      artifact ──────▶ Success | BusinessOutcome | Failure | Escalated
Escalation  lease + inbox + operator console, over a session that outlives the runner
Evidence    JSONL + screenshots + observation snapshots, redacted on the way out
```

**The key decisions.**

*Perception is accessibility-shaped, not DOM-shaped.* Nothing above `Surface` mentions a browser,
a selector, or markup — the whole system is written against `UiElement { role, name, value,
proximityLabel, bounds, frame }`, which is the same tuple Windows UIA or macOS AX hands you. There
is no `evaluate()` escape hatch on the interface; if a capability needed one, the abstraction
would be a lie.

*Two perception providers, not one.* Claiming perception is swappable is cheap; shipping a second
provider is how it gets tested. `--provider cdp` runs the entire demo through
`Accessibility.getFullAXTree`. It is genuinely weaker here — a raw AX tree has no notion of "the
label in the cell to the left", so this portal's unlabelled inputs arrive anonymous — and that
weakness is the useful finding, not a defect. It is exactly why the locator cascade has rungs
below role+name.

*The policy gate is a decorator, not a checklist.* Discovery and replay both hold a `PolicyGate`
and neither holds a reference to the surface underneath it. There is no code path that can act
while bypassing policy, because there is no other way to reach the surface. A guardrail you have
to remember to call is not a guardrail.

*The model decides what to do; the runtime decides how to find it again.* Asking a language model
to emit selectors produces plausible locators that were never tested against anything. Here the
model picks controls by reference number from the rendered screen, and the compiler derives the
targeting from the element it actually touched — verifying, against the recorded observation, that
each strategy it keeps uniquely matched that element. A strategy that was already ambiguous at
record time is discarded rather than shipped as a latent flake.

*Discovery and recording are separate phases.* The first pass through an unfamiliar UI is full of
back-tracking, and recording it verbatim produces an artifact that faithfully reproduces someone's
confusion. The agent explores freely, then calls `start_recording`, the session resets, and it
performs the flow once cleanly. Only the second pass becomes steps.

**Trade-off taken:** a single process, files instead of a database, no queue. The abstractions are
shaped so the fleet version is a deployment change rather than a rewrite — the control lease is
three fields that become a row with a TTL; the intervention inbox is a directory that becomes a
table — but none of that plumbing is built, per the brief.

## 2. Artifact schema

`src/schema/` — Zod, so one definition yields the runtime validator, the TypeScript types, and the
JSON Schema. `npm run schema -- --tool artifacts/<id>.json` renders a capability as a tool
definition another agent can be handed directly: declared inputs become the parameter schema, and
the declared outputs *and business-outcome codes* go in the description. That is the payoff of
typing the contract rather than shipping a step list.

```
CapabilityArtifact
  capability      id, semver, name, description        ← what a calling agent reads
  target          appId, appVersion, surface, entryPoint, allowlist
  inputs[]        name, type, pattern, sensitivity, example
  outputs[]       name, type, sensitivity, required
  steps[]         intent, action, target, risk, precondition, postcondition
  success         Checkpoint
  businessOutcomes[]  code, detect: Checkpoint         ← expected non-success results
  recoveries[]    code, detect, actions[], maxAttempts, then
  provenance      model, runId, tenant, evidence, surfaceFingerprint
```

Four choices carry the design:

**Targets are ranked strategy lists, not selectors.** `role_name → proximity_label → placeholder →
text → ordinal → coordinates`, plus an optional scope and a frame path. The order is the
robustness argument: the top rungs describe what a control *means* and survive restyling, DOM
reordering and tenant skinning; the bottom rungs describe where it happened to be and survive
almost nothing. Replay stops at the first rung that matches and **records which one won**, so a
capability quietly sliding from `role_name` to `ordinal` across a fleet is a visible signal rather
than a mystery flake. `proximity_label` is not a convenience — on this surface the member-ID input
has no accessible name at all, and nothing above that rung can find it. Coordinates are recorded
but never choose an element on their own.

**Scopes make row selection stable.** `row_containing: {input: memberId}` expresses "the View link
in the row for the member we asked about". `ordinal[2]` expresses "the third one", which is true
until the result set changes.

**Business outcomes are declared, not inferred.** "No such member" is a legitimate answer the
caller asked for, not an exception. Declaring the detector in the artifact means replay recognises
it by evidence on the screen and returns `{status: 'business_outcome', code: 'MEMBER_NOT_FOUND'}`.

**Values are typed references.** `{kind:'input'|'extracted'|'const'|'secret'}` — so a reviewer can
see at a glance which values are caller-supplied, which flow from an earlier extraction, and which
come from the environment. Credentials are `secret` and resolved from env at run time; they are
never in the document.

**What is deliberately absent:** no screenshot hashes, no DOM-shape assertions, no embedded code.
Checkpoints are a small declarative assertion language — evaluable with no model and no `eval`,
and reviewable by a human who does not read TypeScript.

## 3. Determinism & error handling

Replay imports no model client. Every decision comes from the artifact.

**Waiting.** There is exactly one waiting primitive: poll until a stated checkpoint holds, or time
out reporting which clause never became true. No fixed sleeps, no `networkidle`. A slow surface and
a broken one are then distinguishable, which is the difference between a retry and a failure.

**Per-step proof.** Each step carries a precondition and a postcondition built from the recorded
screens. Generating these was more subtle than expected and produced two real fixes. First, on a
frameset portal the top-level URL never changes, so `url_matches` evaluates against *every frame's*
URL. Second, the obvious "first heading on the page" picks the navigation menu, which is identical
on every screen and asserts nothing — so the compiler identifies the working frame as the one whose
content varies across the recording, and draws screen identifiers from there.

**The classification order is the whole difficulty.** Executing a step list is easy; deciding what
a screen means when it is not the screen you expected is not. After every step:

1. **Declared business outcome?** → terminate and report it as a result. Checked *first*, before
   any retry logic — checking it last is the common bug, where the engine burns its retry budget
   hammering a screen that is clearly saying there is no such member.
2. **Declared recovery condition?** → apply the remediation within that rule's own budget, then
   **re-verify the postcondition before redoing anything**. Dismissing an interstitial usually
   reveals the screen the step was trying to reach; repeating the action there would be wasted work
   at best and a duplicate submission at worst.
3. **Postcondition holds?** → continue.
4. **Otherwise** → hard failure with step, expected, observed, a remediation hint, a screenshot and
   an observation snapshot; or escalation, if a human could unblock it.

**The result contract** is a discriminated union — `success | business_outcome | failure |
escalated` — with distinct CLI exit codes (0/3/4/1) so a caller can branch without parsing text.

**Recovery policy is per-rule, and `then` matters.** A maintenance banner is `retry_step`. A
dropped session is `restart_flow`: retrying the blocked step would be wrong, because the result set
it expected died with the session. Restart is refused outright once an irreversible step has
executed — replaying a transfer because the session dropped afterwards is far worse than failing.

**Session establishment is an app-level concern, not a capability step.** Recording sign-on into
every capability makes each one unrepeatable the moment a session already exists, and bakes one
institution's credentials into a shared document. It lives once, in the app profile, and the same
`SIGNED_OUT` rule serves as the preflight before a run and as the mid-flow handler.

**Observed in the traces** (`evidence/`): interstitial recovered mid-flow; session dropped and the
flow restarted, with the repeated steps visible in the trace; slow response absorbed with no sleep
anywhere; not-found and permission-denied returned as typed outcomes; malformed input rejected
before a page was opened.

## 4. Heterogeneity & multi-tenant

**Other surfaces.** The seam is `Surface` + `UiElement`. A Windows UIA provider populates the same
fields from `AutomationElement` (`ControlType`, `Name`, `LabeledBy`, `BoundingRectangle`); macOS AX
does the same from `AXRole`/`AXTitle`/`AXFrame`. The artifact schema needs no change — `frame:
string[]` becomes a window/pane path, `role` values come from that platform's vocabulary — and the
replay engine, the checkpoint language, the policy gate and the escalation model are untouched.
The CDP provider is the evidence that the seam holds: swapping perception changed nothing above it.
What *would* need work is acting — a native dropdown is not a `<select>` — which is exactly why
acting lives behind the interface while finding does not.

**Many tenants, one product.** Artifacts are keyed to the **vendor product** (`appId`,
`appVersion`), never to a tenant. Tenant specialization is a separate `TenantOverlay` document that
may retarget a control by `semanticId`, remap screen wording in checkpoints, and add tenant-only
recoveries — and may **not** add, remove or reorder steps, change the success condition, or widen
the allowlist. That restriction is the whole design: if overlays could change the flow, a year later
you have N divergent forks nobody can review or upgrade together. A tenant that genuinely runs a
different flow is a different capability version, recorded and reviewed as such.

This is demonstrated rather than described. The capability recorded against Northgate runs unchanged
against Vale Mutual — different palette, different fonts, reordered result columns — with a
**three-line overlay**: two renamed controls (`Member ID` → `Member Number`, `Search` → `Find
Member`) and one reworded screen title. Everything else — step sequence, checkpoints, business
outcomes, recoveries, extraction — is reused.

**Drift detection.** Three layers, cheapest first. (1) Run the unspecialized artifact against a new
tenant and read the failure: it names the exact literal that moved and points at the overlay
(`npm run replay -- --tenant tenant-b --no-overlay` produces precisely this). (2) `surfaceFingerprint`
in provenance summarizes the recorded screen shapes; a mismatch flags a capability for re-review.
(3) The strategy rung reported in every run trace is the leading indicator — a fleet-wide shift from
`role_name` to `ordinal` on one capability means that product shipped a release, and it shows up
before anything breaks.

## 5. Escalation & handoff

**Detecting stuck.** Four distinct triggers, not one heuristic: a risk ceiling hit
(`ConfirmationRequired` from the gate), a locator that resolves to zero or ambiguously on a step
marked `escalate`, a recovery rule exhausting its budget with `escalateOnExhaustion`, and an
unclassifiable screen at a step where a human could plausibly help.

**The structural requirement is session lifetime.** If the runner owned the browser, "let a human
take control of the live session" would be impossible — the window dies with the process that got
stuck. So `npm run session` starts the browser as its own process and every run *attaches* over
CDP. Automation can exit while the session, its cookies, its scroll position and its half-filled
form stay exactly as they were.

**Control is an explicit fact.** A single-writer lease (`.session/lease.json`) records who holds
the session. The gate checks it before *every* action, so a person who takes over mid-step is not
fighting an automation that is still clicking. Control returns with a *new* token, so a runner that
was killed and restarted cannot resurrect itself into a session someone is now using.

**The loop.** Escalate → write an `InterventionRequest` carrying the capability and version, the
step and its intent, why it stopped, a redacted screen summary, a screenshot, an observation
snapshot and **the CDP endpoint of the live session** → flip the lease to `human` → the operator
console lists it → the operator claims it and works in the same window → they either **authorize
one execution** of the blocked step or say they did it themselves → the lease returns → automation
**re-observes and re-evaluates the blocked step's precondition** before touching anything. If the
operator left the session somewhere unexpected, that surfaces as a precondition failure rather than
a click landing on whatever now occupies those coordinates.

Authorization is single-use and step-scoped. Approving "open this sub-account for this member now"
is not approving every sub-account opening for the rest of the run; a grant that outlives its use
is how an approval gate becomes a rubber stamp. While the human holds the lease, page-level
listeners record what they clicked, changed and submitted into the same evidence stream — an
intervention is evidence of a gap, and throwing it away wastes the most informative event the
system produces.

**Mocked:** the console's presentation — one auto-refreshing page, no streaming video, no auth, no
queue or SLA. **Not mocked:** the request and its context, the lease, the transfer, the blocking of
automation, the capture of the human's actions, the single-use authorization, and the verified
resume. `npm run demo:handoff` runs the whole loop end to end and ends in `SUCCESS` with the
confirmation number returned.

## 6. Safety

**Allowlist, enforced at one place.** Origins, path prefixes, action verbs, and a maximum
unattended risk class — checked in the gate that both discovery and replay act through. The URL is
re-checked *after* every action as well as before navigation, because a click can navigate and an
allowlist that only guards `navigate` is escaped by any link on the page.

**Risk is a property of the step, not the verb.** Clicking "Search" and clicking "Confirm transfer"
are the same verb and very different acts. The recorder proposes a class from the control's
semantics (conservatively: a false positive costs one human confirmation, a false negative moves
someone's money), writes it into the artifact where a human can raise it before the capability ever
runs unattended, and policy decides what each class may do. Above the ceiling, the default is to
**route to a human rather than block** — blocking makes the system useless for exactly the
operations that matter — and irreversible steps are never retried (`maxAttempts: 1`).

**Redaction happens on the read path.** The model never sees a balance or an account number; it
sees `«currency:25fe2a»`. A system that shows the model a member's balance and then scrubs the log
has still disclosed it. Tokens are stable within a run so the model can reason about a value it
cannot read, and reversible **in process only** — the map is never written anywhere and dies with
the process — so the runtime can type a value back into the page and return the real number to the
caller while evidence on disk keeps the token.

**Declared sensitivity outranks pattern matching for outputs.** A regex over rendered text cannot
catch a balance that has been normalized to the number `18204.37` — it no longer looks like
currency. So outputs the artifact declares `regulated` are masked in evidence by their
*declaration*, appearing as `«withheld:currency»`, while the real value is still returned to the
in-process caller. This was a live leak found by grepping the evidence directory during
development, and it is the clearest illustration of why pattern redaction is a backstop and typed
sensitivity is the actual control.

**Artifacts are guarded twice.** The compiler will not build a locator or a checkpoint from a
literal that looks regulated or that equals a caller-supplied value, and `assertNoRegulatedData`
re-scans the finished document and *fails the build* if anything slipped through. An artifact is
committed and copied between environments, so a leak there is permanent and travels. This caught a
real bug during development: the compiler was emitting `text: "$18,204.37"` as a locator strategy.

**Limits, honestly.** Regex over rendered text is a backstop, not a boundary — it will miss a
balance rendered as an image and the currency threshold ($1,000, so instructional copy like
"minimum $25.00" survives) is a configuration choice, not a law. The real answer is field-level
classification driven by the artifact's declared output sensitivity, which is done for outputs and
not for arbitrary screen text. The allowlist trusts the URL the browser reports. Risk classification
from control labels is a weak signal, which is why its output is reviewable rather than load-bearing
at runtime. And none of this defends against a malicious *target application* — a page that renders
instructions to the agent is a prompt-injection surface this system does not address.

## 7. Cuts

**Deliberately not built.**
- *Queues, workers, a tenant registry, any distribution.* The brief penalizes it and it would be
  the least interesting code here. The abstractions are shaped for it; the plumbing is not written.
- *A desktop provider.* The seam is real and argued in §4, and the CDP provider demonstrates that
  swapping perception changes nothing above `Surface` — but no UIA/AX code exists.
- *A co-browsing operator console.* The mechanism is real; the UI is one page.
- *Self-healing locators.* When targeting degrades, the system reports it loudly. It does not
  re-run a model to repair the artifact, because a capability that silently rewrites itself in
  production is worse than one that stops.
- *Artifact generalization from a single recording.* The compiler emits what it verified against
  one screen. Merging several recordings to learn which literals are tenant-specific is the obvious
  next step and is not done.
- *Authentication and authorization for the operator console.* It binds to localhost.

**What I would build next, in order.**
1. **Multi-recording generalization.** Record the same flow against two tenants and diff: literals
   that differ are tenant-specific and belong in overlays automatically, rather than being
   discovered when a run fails.
2. **A capability registry with the fingerprint as a health signal**, so "which capabilities on
   which tenants are degrading" is a query rather than an incident.
3. **Promoting interventions into recoveries.** The human's recorded actions during a handoff are
   already captured in the evidence stream; a repeated intervention with the same shape is a
   recovery rule waiting to be proposed for review.
4. **A UIA provider** against a real desktop app, which is the honest test of §4.
