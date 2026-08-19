# RevTurbine — The Monetization Model

*What the pieces are, what each is for, and how a decision resolves. Load this when
authoring or changing a Playbook. Field-level shapes come from `revturbine schema`; an
orientation to the primitives is in the docs (Concepts); authoring conventions — handle
format, ordering, units, CTA routing for non-public tiers — are in `authoring-rules.md`.
This file carries what none of those do: which type to reach for, how the categories
differ, what resolves in what order, and the semantics that are not guessable from the
schema.*

## The four layers

RevTurbine sits between the customer's billing provider and their application.

- **Plans, pricing and entitlements — the policy layer.** What each plan includes and what a
  given user may do.
- **Placements — the decision layer.** What to show, when, to whom.
- **Segments** inform both: they describe *who* a user is, and entitlement rules, placement
  payloads, plan variations and trial rules all target them.
- **Experimentation and optimization** varies any of it.

Billing stays the source of truth for subscriptions and payment. The application supplies
user context and renders what RevTurbine returns.

## Plans, variations and prices

A **plan** is a tier. Its **variations** carry the commercial terms — one per price,
billing period and segment combination — and each links its own price in the billing
provider. A plan with no priced variation is not sellable. Billing periods include monthly,
annual, quarterly and one-time; a one-time variation models lifetime pricing.

**Add-ons** work the same way and are bought alongside a plan. They are how credit top-ups
and extra seats are modelled. Visibility follows the same three values as plans — public,
unlisted, legacy — and unlisted is the typical choice for expansion packs and one-time
credit bundles: purchasable from a placement or a direct link, absent from the pricing page.

A tier a user cannot self-serve into — an unpriced "Enterprise" — is normal, and routes to
contact-sales rather than checkout.

## Entitlements

An entitlement answers "can this user do this right now, and how much is left?" The type
decides what lever you get. Canonical order:

| Type | What it expresses | Reach for it when |
|---|---|---|
| Feature | On or off | The capability is present or absent |
| Capability Tier | Named levels (Standard, Advanced) | Same feature, different power |
| Usage Limit | A ceiling per period | Consumption you cap and reset |
| Price-per-unit | Charge per unit consumed | Overage beyond an allowance |
| Rate Limit | Speed rather than volume | Protecting cost or infrastructure |
| Credits | A balance that can be topped up | Consumption you sell more of |
| Seat | Per-user licensing | Value scales with people |

**Usage Limit and Credits are not interchangeable** even sharing a unit. A ceiling that
resets each period is a Usage Limit. A balance you top up is Credits — rollover is an
optional per-rule toggle, not part of the definition, and where rollover is on, a top-up
purchase bypasses the Max Balance cap and lowering Max Balance later does not truncate
balances users already hold.

Scope differs by type: **Rate Limit is the only type whose period sits on the entitlement**;
usage periods, credit reset periods and allocation (account pool, per user, per user pooled)
sit on the **rule**. Rate limits are always per user, never pooled.

### Rules bind entitlements to plans

An entitlement grants nothing by itself. An **entitlement rule** is the grant — *these
plans get this entitlement, at these values*. Its parts: the entitlement it grants; the
plans or add-ons it targets; optional segment narrowing; and the values for the type — the
limit and period for usage, the allowance and reset for credits, the tier name, the seat
count.

- **Access exists only where a rule grants it.** No matching rule means denied.
- **Where rules overlap the most permissive value applies**, ties going to the earliest
  rule. An explicit deny rule still denies.
- **Filters widen when absent; grants must be explicit.** Everywhere a plan or segment
  field *narrows* an audience — a rule's segment scoping, payload targeting, trial rules —
  empty or null means "everyone" / "all plans". The grant itself is the exception: a rule
  must name at least one plan or add-on target, and the schema rejects an empty list.

### Enforcement — what happens at the limit

Reaching a limit is not automatically a block. Enforcement is set globally and per rule:
**hard block**; **soft block** (allow the action, show the upgrade prompt); **degrade**
(throttle or limit functionality); **allow overage** (charge per unit via the billing
meter). A **grace period** (hours, on the rule or the global default) delays enforcement
after the limit is reached.

Enforcement decides access; it shows nothing by itself. The user-facing side is
placements: warning thresholds on rules and global defaults emit crossing events, and a
Usage / Credit / Seat placement configured at a matching percentage is what the user
actually sees. Author the enforcement and its placements together.

On the client, an entitlement check **fails closed** — no affirmative grant, no access —
and anything gating real value is re-checked server-side before value is granted.

## Trials

RevTurbine is the system of record for trials: the rules, eligibility, length, state, and
the placements that run on trial events. Billing still handles the money — when a free
trial requires a card, RevTurbine creates the billing subscription with the trial period
attached, passing its own configured length. No-card free trials and reverse trials
involve no subscription at all until conversion, so they exist only in RevTurbine.

- A **free trial** grants a paid plan for a bounded scope — a number of days, or a usage
  allowance (consumption of a named entitlement up to a cap) — with or without requiring a
  card up front.
- A **reverse trial** starts the user on a premium plan and drops them to a fallback unless
  they upgrade. The studio names these **From Plan** (who qualifies) and **Plan Granted**.

Semantics to read, not assume:

- A free-trial rule's plan is a **filter, not a grant** — null means all plans, per the
  filters-widen rule above.
- A time-based rule with no duration is skipped at runtime; there is no fallback length.
  Always set one. (A validation warning for this is specified but not yet built.)
- A **reverse trial does not change the user's commercial plan**: the user keeps their base
  plan for targeting while holding the granted plan's entitlements, so a placement targeted
  at the premium plan does not reach them. A free trial does move the plan.
- Where trials of the same kind overlap, the longest applicable length wins.

## Segments

A **segment** is a named group defined by values within a **dimension**. Values inside a
dimension are mutually exclusive and exhaustive — every user resolves to exactly one value
per dimension, always. That is why dimensions carry catch-all values ("Not in trial",
"New", "Unknown"); a custom dimension needs one too, or the logic breaks.

Composition is **OR within a dimension, AND across dimensions.**

Ten default dimensions: registration state, activity state, subscription state, trial type,
seat type, buyer role, email type, billing health, country or region, device type. Custom
dimensions are built from an SDK trait, a trait enum, a CDP property, or a manual list.
Activity state derives from product events the app reports, not logins.

Availability is not uniform: trial rules accept only email type, country/region and custom
dimensions; seat type and buyer role are unavailable to trials and account-scoped limits.

One thing segments are **not** for: a single named account. Giving one customer a plan,
add-on or entitlement — permanently or until a date — is a **Customer Override**, applied
operationally outside the Playbook. Never author a one-customer segment with its own
entitlement rule to achieve it.

## Placements

A **placement** is a moment plus a trigger — the *when*. The moment is an app request for a
slot, a render, or a scheduled push. The trigger is the condition: a threshold crossed, a
trial event, an entitlement check refused, a qualifier, or none at all ("always-on").

**Qualifiers are the conditions RevTurbine can derive for itself** — the qualifier list is
a closed enum, not a place to add app-specific conditions. A condition only the app knows
("sales eligible", say) is a segment on a trait, not a qualifier.

A placement carries **payloads**. Each payload is specific to an audience (plan and
segment) and a **surface template**, and holds what is shown: the message, up to five
**CTAs**, a recommended plan, and any promotion. **Only the first CTA carries an
actionable path**; the second contributes its label alone, and any beyond that are
dropped without a validation error. Author accordingly.

A **CTA path** is an intent — open checkout, view plans, contact sales, book a demo, open
another placement — and nothing more: **RevTurbine supplies the intent, the application
executes it.** The app registers a handler per path type it uses, plus a fallback, and a
type with no handler is a dead button. Take the type list from `revturbine schema`, never
from memory. A CTA path may be absent, but a payload with nothing to click rarely earns
its place. **Promotions attach to a specific CTA path**, not to the payload, so different
CTAs can carry different offers.

Copy can be written inline or reference a reusable **Message Block** — a first-class
Playbook object. A block may vary by at most one segment dimension and must define content
for **every value** in that dimension, or launch is blocked.

The recommended plan follows a strategy — next tier up by default — and can be overridden
per payload. It resolves the recommended-plan tokens in copy.

**Category, trigger type, entitlement, surface slot, trial type and qualifier are locked
after creation.** Getting the category wrong means authoring a new placement.

### The six categories

| Category | Initiated by | Fires when | Example |
|---|---|---|---|
| Fixed | App | The app renders that surface | Header upgrade button, plans page |
| Access Gates | App (user-prompted) | An entitlement check returns denied or limited | "Upgrade to unlock AI Export" |
| Usage / Credit / Seat | RevTurbine | A threshold is crossed | "80% of storage used" |
| Trials | RevTurbine | A trial lifecycle event | "Trial ends in 3 days" |
| Conversion / Expansion (Other) | RevTurbine | A qualifier matches | Seasonal promo, invite a teammate |
| Retention | RevTurbine | A qualifier matches | Payment failed, at-risk re-engagement |

A cancel-save offer is **Fixed, not Retention** — the user clicked cancel, so the app
initiates it at a cancel-flow slot. The same holds for anything else the user walks into.

A refused entitlement check does not display anything by itself: the `<Gate>` component
resolves and renders the configured gate placement automatically, while an imperative check
requires the app to request the placement for that entitlement as a second step. Where a
denied entitlement has no Access Gate placement of its own, a **catch-all default gate**
fires with generic copy — in hosted mode; the catch-all lives server-side, so local mode
has none and the gate component's static fallback is the backstop. Author specific gates
either way: generic copy converts poorly.

App-initiated placements fire whenever their condition is met. RevTurbine-initiated ones
are scheduled and paced.

## Surfaces — three different things

Confusing these produces config that can never render.

- A **Surface Slot** is a location in the customer's code. It is **auto-discovered** the
  first time the app requests it — there is no registration step. Slots show as live or
  idle.
- A **Surface Template** is the field structure a payload fills in — header, body, CTA and
  so on. Templates are defined in RevTurbine, not in the Playbook.
- A **Surface Type** classifies templates, and placement decisioning filters on it: a slot
  declared as a banner will never receive a payload built on a modal template.

A **modal** takes over the screen — request one only after a user action, on completion, or
at a natural transition, never on passive render. **Banner, in-page, button and toast** are
safe on render. Outbound channels such as email exist in the model for the
RevTurbine-initiated categories, but outbound dispatch is not built yet.

Placements are additive: a slot with no winning payload renders nothing, and the product
must remain fully usable in that state.

## How a decision resolves

**What starts it.** The app requests a slot or checks an entitlement, or RevTurbine
schedules an outbound push.

**Which payloads are candidates.** A placement qualifies when its trigger condition is met,
or it is always-on. Within it, a payload is a candidate when the user sits inside its plan
and segment targeting *and* its surface template belongs to the surface type the slot
declared. Fail any of these and the payload is out.

**Whether policy allows delivery.** Caps, cooldowns and suppressions are applied — see the
next section. Fixed placements and Access Gates skip this stage.

**Which candidate wins.** Contention only arises when two placements would occupy the same
surface slot for the same user — placements on different surfaces fire independently.
Where they do contend, the order across categories is fixed: **Access Gates, then Fixed,
then usage and trial placements as one combined pool, then conversion and retention as
another.** A user blocked by a gate sees the gate, not a promotion.

Within the usage-and-trial pool, key events outrank warnings, in three classes: a trial
transition (started, ended, converted) beats a limit reached or exceeded, which beats any
warning — a sub-threshold usage alert or an in-progress trial milestone. Warnings rank by
percent consumed (usage against its limit, or trial time elapsed), capped at 100, so two
over-limit candidates tie. Where several milestones of one entitlement or trial qualify at
the same opportunity — an 80% and a 90% warning, or a trial-progress and a trial-ending
milestone — only the latest shows; the earlier ones are dropped, not queued. Every request
re-evaluates from current state, so a milestone that no longer qualifies (usage has reset,
the user upgraded) doesn't fire.

Conversion / Expansion and Retention placements rank by **expected impact on revenue**
for that user — the ML prioritization that is a Growth-plan capability, not yet shipped.
Without it they fall back to their configured order in the Playbook, so keep that order
deliberate.

**Delivery.** One placement wins per opportunity, and its matching payloads render on their
respective surfaces.

## Caps and cooldowns

Pacing is layered, and the layers apply differently by category.

- **Per-payload caps** — how often this payload may reach one user, per session, day,
  week, month or lifetime, plus a cooldown after dismissal. These apply to Usage / Credit
  / Seat, Trials, Conversion / Expansion and Retention payloads.
- **Overall cap rules** — a budget across a group of surface templates or slots, so
  unrelated nudges cannot stack. **These apply only to the Conversion / Expansion and
  Retention categories.**

**Fixed placements and Access Gates are exempt from both.** You cannot pace a gate, and
should not try.

A dismissal is the user saying no. The payload-level cooldown after one defaults to seven
days; a tenant-level fallback (`default_dismiss_cooldown_hours`) covers payloads that
carry no value of their own. A cap of zero, or a cooldown longer than its own cap period,
disables the payload without saying so — to take a payload out of rotation, set its
status to `paused` instead.

## User context — what the application supplies

RevTurbine decides for a specific user and knows only what the app tells it.

| Field | Required | Authoritative source | Notes |
|---|---|---|---|
| User id | Always | App | Stable, non-guessable, always app-supplied — there is no anonymous mode; signed-out users are a roadmap item. Empty ids are rejected; email-shaped ids warn |
| Plan | Yes, for now | RevTurbine, from billing | The app may also supply it to grant access instantly at upgrade |
| Usage balances | If an entitlement meters it | Customer counts, RevTurbine persists | Absolute balances, reported by the app |
| Credit balances | If an entitlement uses credits | Customer counts, RevTurbine persists | Same model |
| Trial state | Optional | App today, RevTurbine planned | Countdown displays locally; the cutoff is server-verified |
| Traits | Optional | App | Whatever custom targeting reads |

**The Playbook and the application must agree.** A segment predicate on a trait the app
never sends can never match, and a usage limit whose balance is never reported is never
enforced. Playbooks are often authored before the wiring exists, and that is fine — record
what the app must supply (trait keys, balance keys, slot ids) as part of the authoring
output so the wiring step implements it, and treat anything not yet wired as not yet live.

RevTurbine does not meter usage today — the customer counts and reports it. An opt-in
metering service is planned; reported balances remain the default.

## What references what

Handles are the connective tissue. Every reference below must resolve.

- Plan and add-on variations → their plan or add-on, a segment, a billing price
- Entitlement rules → their entitlement, plans or add-ons, segments, seat types
- Placement triggers → an entitlement handle plus threshold, a surface slot, a trial
  milestone, or a qualifier
- Placement payloads → plans, segments, a surface template, content
- CTA paths → a plan, a promotion, or another placement — **chained targets must be Fixed
  placements**
- Message blocks → a surface template, and a segment dimension they vary by
- Trial rules → the plans they grant and fall back to, segments, any usage entitlement

Offline validation (`revturbine validate <file>`) checks structure; unresolved references
and incomplete rules surface as launch-blocking findings from the server-side check
(`validate --draft`). Validate rather than assuming.
