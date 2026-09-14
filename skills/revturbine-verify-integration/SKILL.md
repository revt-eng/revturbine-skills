---
name: revturbine-verify-integration
description: >
  Audit a RevTurbine integration end-to-end and report findings — the
  Playbook against the code that consumes it, revenue-critical actions
  against their server-side re-checks, authored behavior against what the
  app actually enables, and the app's baseline behavior when RevTurbine
  returns nothing. Read-only: it changes nothing; fixes route to the
  owning skill. Use before a first production launch, when someone says
  "verify the integration", "audit this", "check my setup", "is it safe to
  launch", after any SDK version or Playbook schema change, or whenever the
  app misbehaves — a gate that never locks, a placement that never shows, a
  limit that never bites, events missing from analytics. Also the place that
  says when a problem is RevTurbine's rather than yours and should be
  reported instead of worked around. Skip if the job is making a known change: authoring the
  Playbook (revturbine-author-playbook), wiring the UI
  (revturbine-wire-monetization-surfaces), connecting Stripe
  (revturbine-connect-billing), or launching
  (revturbine-release-lifecycle). Load revturbine-start-here first if this
  session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.10.0"
  safety_class: read-only-inspection
  schema_version: ">=0.1.0 <0.2.0"
  tier: free
---

# RevTurbine — Verify Integration

You are the auditor. You read the Playbook, the code, and the live
decisions, and you produce findings — **you change nothing here.** Every
fix routes to the skill that owns it, so your human sees a finding before
anything acts on it. Nobody at RevTurbine reviews an integration; this
audit is the review.

What you are looking for is **mismatch**. A Playbook is a set of names —
entitlement handles, slot ids, plan handles, trait keys, usage keys — and
the app repeats those names in code. Where the two disagree, RevTurbine
does not error: it denies, or renders nothing, or renders the wrong
thing, or stops enforcing a limit. Almost every failure in this system is
a name that agrees with nothing, failing quietly. The appendix carries
the seam-by-seam detail; work from it while you audit.

## Establish what you are auditing

Classify the integration state first (`revturbine-start-here` →
Determine the current RevTurbine state), then pick the Playbook to audit
against and **say which one you picked**:

- **Auditing before a launch** — audit the **staged draft**: it is what
  is about to reach users. If nothing is staged, audit the Playbook that
  *would* be launched (the local file on a first hosted cutover); if there
  is none, stop — the launch has no candidate to assess.
- **Diagnosing something wrong in the app** — audit what the app is
  actually running: the live Release in hosted mode, or the local
  Playbook file in local mode. Auditing a draft here would audit config
  nobody is hitting yet.
- **Local mode** — the Playbook the app loads, found by following the
  provider's import (`localRuntime: { playbook }`). A Playbook file
  saved anywhere else is not the one running.

In hosted mode, pull the server-side Playbook rather than trusting a local
copy (`revturbine download --draft` or `--live`), after confirming the
tenant (`revturbine whoami`).

Then inventory the app's side of every name: entitlement handles checked
(`rt.can()`, `useCan()`, `<Gate can>`, `rt.gate()`, and the backend's own
check),
slot ids rendered (`<Slot id>`, `usePlacement()`), trait keys and usage
keys the app reports (`identify()`, `setUserContext()`, `update()`),
event names it fires (`rt.track()`), and the CTA resolver map. This
inventory is one side of every check below.

## Drive the SDK's own diagnostics — don't audit by eye

The SDK holds both halves of most mismatches at runtime and will hand
them to you — call the probes on the running instance `useRevTurbine()`
returns inside the app. Reading code to guess at what it would decide is slower and
less reliable than asking it — `explainPlacementDecision()` for why any
decision came out as it did, `getTargeting()` for the trait diff,
`getUsage()` for unmapped usage keys, `getPolicy()` for the behavior
flags, `getTelemetryCounters()` for failed event delivery. The appendix
lists each probe and what it answers.

Read decisions rather than infer them: every result carries a `reason` or
`reasonCodes`, and `decisionSource: 'fallback'` means the answer was
degraded rather than evaluated. Where a check needs the set of allowed
values — CTA action types, enforcement modes, trigger types — get it from
`revturbine schema`, never from memory.

## The audit

Work the seams in this order — it is the order of consequence. Appendix
sections 3–6 and 8 carry the detail for items 1–4; items 5 and 6 are
self-contained. Report per group even when clean.

1. **Money and wrong answers.** The production build actually runs in
   hosted mode — **an app left in `local_only` (local mode) serves a frozen Playbook
   and emits nothing, and nothing errors.** Usage, credit and seat keys
   the app reports against the handles the rules limit — **a key that
   matches nothing is read as zero consumed, so the limit never bites.**
   The plan in the user context against the Playbook's plans — it must
   be `plan_handle: 'pro'` or `plan: { handle, name }`, matching the
   plan's `unique_handle`. **A missing or wrongly-keyed plan binds no
   plan**, and on **SDK ≥ 0.4.0** the check then denies with
   `reason: 'no_plan_identity'`. On **0.2.x it GRANTED instead** —
   plan targeting was skipped rather than failed, so a mis-keyed plan
   handed every user the paid feature silently; `plan: { id, name }` was
   the correct shape there and stopped resolving in 0.3.0. Test a
   paid-only entitlement as a free user and require a denial — and if
   denials appear everywhere, read the `reason` before suspecting the
   Playbook: `no_plan_identity` means the plan never bound. Likewise the
   user id: an empty or absent id mints a random anonymous UUID per
   init, silently.
   Every revenue-critical action re-checked on the backend before
   value is granted, and a trial's paid cutoff anchored to server time
   rather than the client clock. The same user id space on client and
   server. Server secrets absent from every client bundle.
2. **Content that never shows, or shows the wrong thing.** Entitlement
   handles, slot ids, surface templates, and CTA action types, each in
   both directions — a name in the code that the Playbook lacks, and a
   name in the Playbook that the code never renders. Trait keys the
   segments target against the traits the app sets. Gating on the right
   state: gates must branch on `allowed`, not on `status`, and must
   agree with each other. Copy rendering with its personalization tokens
   resolved, not as literal `{{…}}`.
3. **Authored behavior that never runs.** Caps, cooldowns and trial
   triggers enable themselves from what the Playbook authors (the
   `placementBehavior` flags derive from it; explicit options override) —
   but interaction reporting and impression exposure still need the
   app's half, and **everything here fails silently when unfed.** The
   same applies to every user-context field the Playbook's rules,
   triggers, qualifiers and segments depend on — appendix 8.
4. **Transport and keys.** Events actually arriving, the ingest key
   present and accepted, and no silent fallback swallowing the
   clickstream.
5. **The app renders its baseline UI without a placement.** Exercise
   the empty state: run the app with the SDK disabled or every provider
   failing and watch what a user sees. Expect no blocking spinner on SDK
   readiness, a sensible fallback where no placement matches a gate, and
   no dead ends. Placements resolve to nothing and entitlement checks
   **deny** in that state (access needs an affirmative grant), so confirm
   no page depends on a grant to render its baseline.
6. **Rendered surfaces are usable.** Modals and banners must be
   dismissible by keyboard, manage focus sanely, and stay readable at
   normal zoom and contrast. A paywall a user cannot escape is a
   blocking finding.

Offline validation (`revturbine validate <file>`) checks the Playbook's
shape, not its coherence, and nothing in the toolchain reads the app's
code. **Cross-references are yours to walk** — see appendix 7.

## Prove decisions at the boundaries

A Playbook can be well-formed and still wrong, so run the real engine and
compare its answers against what the code expects. Do not try every
combination — **cover each decision-relevant dimension at its edges**:

- one user per plan;
- each segment that gates or targets anything, and one user in none;
- each usage, credit or seat limit checked just under and just over — the
  just-over case is where a mis-keyed balance shows itself as a limit
  that never bites;
- each trial state a placement depends on: started, in progress, ending,
  ended, converted — `converted` is a server-side transition the client
  never derives, so it is unreachable in local mode.

In hosted mode, evaluate against the version you are auditing
(`revturbine evaluate --draft --user <ctx.json> --entitlement <handle>`,
or `--slot <id>`, with `--plan-handle` to vary the plan). In local mode,
drive the app itself and read the decisions. Cross-check against the
Playbook's rendered summaries (`revturbine show <kind> --draft` for each of `plans`, `entitlements`,
`segments`, `placements`, `trials`), which surface a limit on the wrong
tier faster than JSON.

## Specify durable tests — don't write them

Name the tests that would hold each finding in place: the entitled and
denied paths of a gate, the baseline render when a placement resolves to
nothing, a usage limit asserted just over the boundary, the server
re-check on a revenue-critical action. **Writing them is app code, which
you do not touch here** — hand the list to
`revturbine-wire-monetization-surfaces` if your human wants them built.

## Report and route

End with a findings report ranked by consequence: unenforced limits and
unverified revenue paths first, then names that do not match, then inert
features and hygiene. For each finding give the evidence (file and line,
or the probe output), what an end user experiences because of it, and the
fix's owner — Playbook content is `revturbine-author-playbook`, UI wiring
is `revturbine-wire-monetization-surfaces`, Stripe and prices are
`revturbine-connect-billing`, launching a fix is
`revturbine-release-lifecycle`. Say plainly which findings you proved and
which you inferred.

If the audit was pre-launch and comes back clean, say so and hand off to
`revturbine-release-lifecycle` — launching is your human's call.

## When to stop and tell RevTurbine

Most integration problems are integration problems, and this audit finds
them. A few are not, and grinding on those costs weeks — one integration
spent three attempts and a `MutationObserver` working around a defect that
was ours.

**Escalate when the audit comes back clean and the behavior is still
wrong.** Concretely, any one of these is enough:

- **`diagnoseSlotInventory()` reports no findings and the placement still
  does not render.** Ask the running app rather than comparing slot ids by
  eye:

  ```ts
  const d = sdk.diagnoseSlotInventory();
  console.log(d.configAvailable, d.authoredButUnmounted, d.mountedButUnauthored);
  ```

  `authoredButUnmounted` is a placement targeting a slot no code renders —
  it can never show, and nothing else reports it. `mountedButUnauthored` is
  a slot rendering its fallback forever. **Check `configAvailable` first**:
  when it is `false` no Playbook reached the SDK, so `authored` is empty for
  a completely different reason than "nothing is authored", and the two are
  indistinguishable without it.

  Both lists empty, config available, targeting matches, and still nothing
  on screen — that is a correct configuration producing silence, which is
  not a configuration problem.
- **`explainPlacementDecision()` disagrees with what the app actually
  does.** The probe and the decision path are supposed to be the same
  answer. When they differ, at least one of them is wrong, and neither is
  yours.
- **A documented option has no observable effect** after you have confirmed
  it reaches the SDK — you passed it, the value is what you think it is, and
  nothing downstream changes.
- **Behavior changed across an SDK upgrade and the changelog does not
  mention it.** `CHANGELOG.md` in the SDK repo records every breaking change
  with the version it landed in and the version that made it fail closed. A
  behavior change absent from it is either undocumented or unintended.
- **You have followed the remediation an error message gave you and the
  error is unchanged.** Read it from `initStatus` rather than the console —
  it is on the React context and is populated even when the SDK instance is
  `null`, which is exactly the case where nothing else is reachable:

  ```tsx
  const { initStatus } = useRevTurbine();
  if (!initStatus.ok) console.log(initStatus.phase, initStatus.message, initStatus.remediation);
  ```

  Every init-path error carries a `remediation` naming the fix. If you have
  done what it says and `initStatus` is unchanged, the remediation is wrong
  or the fix does not work — either way it is ours.

Do not keep trying workarounds past this point, and do not tell your human
the integration is wrong when you have evidence it is not. Say what you
observed, say you believe it is a product defect, and offer to file it —
`revturbine-start-here` → If you get stuck has the route. Include the SDK
version, the Playbook (redacted), the exact reproduction, and which of the
conditions above you hit. Paste the `diagnoseSlotInventory()` output and the
`initStatus` object when they are relevant — both are structured, neither
contains user data. Never include tokens or secrets.

These probes need **`@revturbine/sdk` 0.8.0 or newer**. On an older version
the first and last conditions are a manual comparison instead; the rest read
the same.

## If you get stuck

Command syntax comes from `revturbine <command> --help`, never from
memory. For anything else, follow `revturbine-start-here` → If you get
stuck.

---

# Appendix — the seams in detail

Almost nothing here throws. RevTurbine is built to never break the host
app, so a mismatch degrades instead of erroring: an entitlement denies, a
slot renders nothing, a limit stops being enforced. **Treat "no error" as
no evidence.** Confirm each seam positively.

## 1. How to read a decision

- `EntitlementResult.reason` — why access was granted or refused, e.g.
  `no_matching_entitlement_rule` (no rule grants this entitlement to this
  user), `feature_not_enabled_for_plan`, `usage_limit_reached`,
  `credit_balance_exhausted`, `entitlement_service_unavailable`,
  `entitlement_check_error`.
- `decision.reasonCodes[]` — why a placement did or didn't show, e.g.
  `placement_not_registered`, `no_candidates_for_template`,
  `no_eligible_candidate`, `plan_target_mismatch`, `trial_trigger_unmet`,
  `threshold_trigger_unmet`, `entitlement_gate_unmet`, `cap_exceeded`,
  `placement_retired`, `sdk_disabled_provider_failure`.
- `decision.decisionSource` — `cache` or `remote` means the engine
  evaluated; **`fallback` means the answer was degraded**, not decided. A
  `fallback` answer proves nothing about the configuration, so never
  audit against one.
- `decision.suppressionReason` — why a placement that could have shown
  was held back.

**A decision reporting `visible: true` is not proof a user saw
anything.** Rendering can still fail after a successful decision, and the
delivery telemetry follows the decision, not the pixels. Confirm at least
one placement visually.

## 2. The probes

Call these on a running SDK instance rather than re-deriving facts from
source.

| Probe | Answers |
|---|---|
| `explainPlacementDecision(input)` | The richest one. Per-rule `matchesPlan` / `matchesSegment` / outcome, and per-predicate verdicts for every segment. Use it on any decision that surprises you. |
| `getTargeting()` | Returns `configuredTraitFields` (trait names the Playbook's segments reference) **and** `traits` (what the app supplies). Diff them — the SDK never does. Also `segmentIds`, `plan`. |
| `getUsage()` | Resolved usage snapshot. **An entry with no `limit` is an unmapped usage key** — the symptom of the highest-consequence seam. Sees only balances sent via `update({ usage })`: an app that passes usage per call (`can(handle, { used })`) shows `{}` here, so read those call sites instead. |
| `getPolicy()` | `runtimeMode` plus the placement behavior flags. The whole "authored but inert" check in one call. |
| `getEntitlements()` | Every entitlement result resolved so far, keyed by handle. |
| `getTelemetryCounters()` | `{ sent, failed, dropped, redacted }`. **A non-zero `failed` is the only visible trace of a rejected ingest key or a blocked origin.** |
| `validateUiPathResolvers()` | CTA action-type coverage, with structured issues. RevTurbine supplies the intent and the app executes it, so an authored type with no resolver is a dead button. |
| `getExportedConfig()` | The Playbook the SDK actually loaded — check this rather than assuming the file on disk is what the app is running. |
| `getUserContext()` | The resolved identity the decisions are running against. |
| `getTrialStatus()` | The trial state the decisions see. Trial triggers gate on this, and the app supplies it — see appendix 8. |
| `<PlacementDecisionInspector>` | Renders the explain output visually. Good for showing your human a finding rather than describing it. |

Server-side, the CLI evaluates the same engine against a named version:
`revturbine evaluate --draft|--live --user <ctx.json>` with exactly one
of `--entitlement <handle>` or `--slot <id>`, plus `--plan-handle`.

## 3. Money and wrong answers

**Runtime mode in production.** Check what the production build actually
initializes with, not what the docs say. An app shipped in `local_only`
resolves against whatever Playbook was bundled at build time, so every
config change after that deploy is invisible, and it emits no telemetry
at all — no funnels, no caps, no attribution. Nothing errors; the app
looks healthy. `getPolicy().runtimeMode` reports what the running
instance believes. Check the production code path, not just local dev.

**Trial cutoffs.** A trial's countdown and milestone nudges are derived
locally and that is fine. The moment paid access **ends** must be
anchored to server time and verified server-side — a client clock can be
set back. Confirm the cutoff is not enforced from the browser alone.

**Usage, credit and seat keys.** The app reports balances
(`update({ usage })` — `update()` accepts the whole user context except
the id); entitlement rules limit against handles. **A balance reported under a key that resolves to no
handle is not an error — the check reads consumption as zero, so the
limit never bites.** This is the one place in the SDK where a mistake
grants access rather than refusing it, and it sits directly on metered
revenue. Detect it with `getUsage()` (per-call usage context is invisible to it — see the probe table) — look for an entry carrying no
`limit` — then evaluate the entitlement just over its limit and confirm a
denial. If a usage-limited entitlement still allows just over its limit, the
key is not connecting.

Related: the threshold itself comes from the Playbook rule for the
user's plan, not from the user context — a `limit` supplied on the user
context feeds personalization tokens only. Threshold placements that
never fire with correct-looking usage usually mean the rule defines no
limit for that plan, or the plan handle is wrong.

**Plan handle.** The two failure directions are opposite, which makes
this confusing to diagnose: a **typo'd** plan handle matches no rule's
plan targets, so **every entitlement denies**; an **absent** plan handle
skips plan targeting entirely, so rules match on segments alone and
entitlements can be **granted to a user with no plan**. Check
`getTargeting().plan` and `explainPlacementDecision()` → `matchesPlan`.
Plan targeting is explicit — a rule grants only the plans it names (the
schema requires at least one target).

**Server-side verification.** The client check is a UX hint; anything in
the browser can be edited. Every action that costs your human money or
moves their end users' money — usage overage, credit spend, seat
provisioning, the moment a trial's paid access ends — must be re-checked
on the backend before value is granted. No probe finds these: read the
backend routes against the entitlements the Playbook meters. Check the
backend has a RevTurbine SDK at all first (`revturbine-start-here` →
Determine the current RevTurbine state): a language RevTurbine does not
ship for cannot re-check, which is a finding in its own right, not
something to work around. Two server-SDK behaviors to check where one
exists: a batch
entitlement evaluation **omits** handles that errored rather than denying
them — the caller must treat an absent result as a denial, never a grant; and batch
placement responses are matched to requests by position.

**Identity.** The client and server must be talking about the same user,
and nothing enforces it — a backend passing a database id while the
browser identifies by email produces confident, unrelated answers on each
side. Then the hygiene: a stable, non-guessable id (**never an email**),
always app-supplied — there is no anonymous mode, and signed-out
visitors are a roadmap item, so RevTurbine on a pre-signup surface is a
finding. Empty-id rejection is specified but not built — confirm the app
always supplies an id.

**Keys.** The server secret belongs only on the backend; the browser
carries the client-scoped key and the public ingest key. No key shape is
validated at runtime, so a wrong key type fails as a rejected request
rather than an error. Grep the client bundle for the secret.

## 4. Content that never shows, or shows the wrong thing

**Entitlement handles, both directions.** A handle the code checks that
the Playbook never defines, and a handle the Playbook defines that no
rule grants, **produce the same denial with the same reason** — the
reason code alone cannot tell a typo from an ungranted entitlement.
Resolve it by checking the handle exists (`getExportedConfig()` or
`revturbine show entitlements`), then whether a rule grants it
(`explainPlacementDecision()` lists every rule and its outcome). The
reverse direction matters as much: an entitlement no code ever checks is
either dead config or a gate someone forgot to wire.

**Slot ids, both directions.** A slot id in the code that no placement
targets may not render empty — verify what the slot actually renders
rather than assuming nothing appears. A placement targeting a slot no
code renders **can never show**, and nothing reports this; there is no
probe, so walk the Playbook's placement triggers against your inventory
of rendered slots.

**Surface templates.** A mismatch yields `no_candidates_for_template` and
nothing renders. An **unrecognized** template is worse: it resolves to a
generic surface type that may have no renderer, so nothing appears while
the decision reports success. This is the case that most justifies
confirming a placement visually.

**CTA action types.** The best-covered seam —
`validateUiPathResolvers()` reports coverage and initialization fails
when a resolver is missing — with two gaps: the React provider reports an
initialization failure generically, so run the check directly to see
*which* action type is missing; and at runtime an unhandled type falls
through to a generic handler or, if malformed, silently behaves as a
dismiss. A CTA that closes the surface instead of opening checkout looks
like it works.

**Trait keys.** A predicate on a field the app never sets never matches,
so the segment is empty and everything targeted at it goes dark. Diff
`getTargeting().configuredTraitFields` against
`Object.keys(getTargeting().traits)` — both halves are right there.

**The `limited` state.** `limited` means at or past the cap, not
approaching it, and it can be granted or denied depending on the rule's
`enforcement`: `degrade` gives `limited` + allowed (the feature runs,
degraded), unset enforcement gives `limited` + **denied**. Code that
branches on `status === 'limited'` therefore admits and refuses the same
user depending on how the rule was authored; the reliable test
everywhere is `allowed` (`useCan()` exposes it as `can`). Check every
gate agrees. Whether a user at the limit should be degraded rather than
blocked is an authoring choice — ask your human, and route the change to
`revturbine-author-playbook`.

**Personalization tokens.** Placement copy can carry tokens that resolve
from plan, usage, or trial state. A token the runtime cannot derive
renders as its literal `{{token}}` text to the end user. Render each
placement that uses tokens and read the output — this is visible to
end users and invisible in JSON.

**Modal timing.** A modal takes over the screen, so it belongs after a
user action, on task completion, or at a natural transition — never on
passive page render. Check where modal-surface placements are requested.

## 5. Authored behavior that never runs

Configured in the Playbook, inert until the app does its half. None of
these errors.

| Authored | The app's half | If missing |
|---|---|---|
| Frequency caps and cooldowns | Nothing to enable — the flag derives from the Playbook authoring one; confirm with `getPolicy()`, and check no explicit `placementBehavior` option overrides it off | Caps never apply; the same surface shows every time |
| Dismiss / snooze / convert | The app calls the interaction methods when the user acts | Placements never retire or cool down; the user sees the same modal forever, and conversion has no outcome data |
| Impression exposure | The exposure ref attached to the placement's visual root, under render or viewport exposure modes | Impressions never fire, so caps never tick and analytics under-counts |
| Trial lifecycle triggers | The trial fields fully populated (the trigger flag derives from the Playbook, same rule as caps) | Trial placements never fire; partial trial state breaks trigger gating specifically |
| Activity-state segments | The product events they derive from, fired via `rt.track()` — resolved server-side, not against a purely local Playbook | The segments never fill, and everything targeted at them goes dark |

`getPolicy()` reports the flags in one call. For the rest, trigger a
placement and confirm the events arrive.

## 6. Transport and keys

Event delivery never throws into the app. When the public ingest key is
missing the SDK falls back to the client API key, which the ingest
endpoint refuses — **so every event can vanish with no error anywhere.**
The only in-process signal is a non-zero `failed` count from
`getTelemetryCounters()`. A blocked browser origin fails the same way. If
decisions work but analytics is empty, audit the key and the origin
allowlist before anything else.

A malformed Playbook throws at initialization but is swallowed on
refresh, leaving the previous config in place. If the app's behavior does
not match the Playbook you are auditing, confirm which Playbook the SDK
actually holds (`getExportedConfig()`).

## 7. What the toolchain does not check for you

Offline validation checks the Playbook's shape — schema conformance and a
small set of semantic rules — and the authoritative catalog runs
server-side against a staged draft (`revturbine validate --draft`).
Neither reads the app's code, and cross-reference resolution inside the
Playbook is not currently covered.

So walk the Playbook's internal references yourself, at least for the
entities the app depends on: entitlement rules naming their entitlement,
plans, and segments; placements naming their entitlement and slot; payloads naming templates
and content; trials naming plans and entitlements.
A name that resolves to nothing is a silent failure in exactly the same
way a code-side mismatch is.

## 8. The user-context contract

RevTurbine decides from what the app tells it about the user, and the
Playbook decides what that has to include. Derive the contract from the
Playbook you are auditing rather than from a checklist: walk its
**entitlement rules, placement triggers, qualifiers and segment
definitions** — the four places that read user context — list the field
each one needs, then confirm the app supplies every one. A user id and a
plan are always required; everything else is conditional on what this
Playbook uses.

| Authored | The app must supply | If it doesn't |
|---|---|---|
| Any entitlement rule | The plan handle | Covered above: a typo denies everything, an absent handle grants on segments alone |
| A usage, credit or seat limit | That entitlement's balance, under its handle | Consumption reads as zero — the limit never bites |
| A usage / credit / seat threshold trigger | The balance — the limit comes from the Playbook rule for the user's plan | No limit in the rule for that plan, and the placement never fires |
| A trial trigger | The whole trial object — `in_trial`, `state`, `trial_limit_type`, `progress_percent`, plus `days_remaining` for a time-based trial | Every trial placement stays silent, and partial state kills the trial-ending trigger specifically |
| A Retention qualifier | `payment_failed` / `payment_at_risk` | The qualifier reads these as exactly `true`, so an absent signal never fires the recovery placement |
| A capability-tier threshold trigger | `tiers`, per capability-tier handle | The user ranks below every threshold |
| A segment predicate | The trait key it reads | The segment is empty and everything targeted at it goes dark |

**Trial state is the one to check hardest**, because RevTurbine does not
own it today: unless the app reads trial status from RevTurbine, it must
set the whole object itself. Read what the decisions actually see
(`getTrialStatus()`), not what the app intends to send.

Two failure directions, and they are opposite. **Balances fail open** — a
missing or mis-keyed usage or credit balance reads as zero consumed, so
the limit stops being enforced. **Every trigger gate fails closed** —
thresholds, trials, qualifiers and tiers all evaluate false on absent
state, so the placement silently never fires. Neither errors, so a clean
console proves nothing either way.
