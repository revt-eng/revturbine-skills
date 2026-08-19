---
name: revturbine-wire-monetization-surfaces
description: >
  Connect a Playbook to the app's screens — gate features behind
  entitlements, render the slots where placements appear, handle CTA
  clicks, and report the usage, events and traits that decisions read.
  Writes app code, one call site at a time. Use when someone says "gate
  this feature", "add a paywall", "add an upgrade button", "show a usage
  meter", "wire up the banner", "hook up the CTAs", "report usage", or
  wants to replace hard-coded plan checks like user.plan === 'pro'. Skip
  if the job is deciding what to charge for
  (revturbine-author-playbook), a first SDK install
  (revturbine-integrate-sdk), auditing an integration
  (revturbine-verify-integration), or launching
  (revturbine-release-lifecycle). Load revturbine-start-here first if
  this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.7.0"
  safety_class: writes-app-code
  schema_version: ">=0.1.0 <0.2.0"
  sdk: "^0.2.77"
  tier: free
---

# RevTurbine — Wire Monetization Surfaces

You are connecting a Playbook to the app's screens. The decisions — what
to charge for, what is gated, what the copy says — were made when the
Playbook was authored. Your job is the app-side half of each one, and it
comes in four kinds:

- **Gates decide.** An entitlement check at a feature's call sites: the
  entitled see the feature, everyone else the upgrade path — with a
  backend re-check behind anything of real value.
- **Slots show.** Locations in the UI where Playbook content renders —
  and where nothing renders when no placement matches.
- **CTA handlers act.** The app code that runs when a user clicks a
  button inside that content — open checkout, show plans, book a demo.
- **Reporting informs.** The usage counts, events and traits the app
  sends. This kind produces no pixels, and most silent failures live
  here: a decision that reads a value the app never sends simply never
  fires.

Every monetization feature your human names decomposes into these four —
the table below maps the common ones. Two rules hold throughout. **One
call site at a time**, so your human reviews each change, and confirm
before wiring anything they have not named. And **the app never
breaks**: with RevTurbine absent or a slot empty, every page renders its
normal UI.

## Read the work order

If `revturbine-author-playbook` ran, it left notes
(`revturbine-playbook-notes.md`) recording what the app must supply —
slot ids, trait keys, balance keys. Start there. Then derive the
complete list from the Playbook itself; every row is mechanical, and
missing one is silent:

| In the Playbook | The app's half |
|---|---|
| An entitlement with a granting rule | A gate at each call site where the feature is used — plus the backend re-check where real value moves |
| A Fixed placement | A slot at the slot id it targets |
| An Access Gate placement | Nothing extra — it renders through the entitlement's gates |
| Any RevTurbine-initiated placement (usage / credit / seat, trial, conversion, retention) | A slot whose declared surface type matches the payload's template — see "Render the slots" |
| A CTA path on any payload | A handler for that action type |
| A usage, credit or seat limit | The balance, reported under the entitlement's handle |
| A segment predicate on a trait | That trait, sent on the user context |
| A trial trigger | The trial object on the user context — the app supplies trial state today; RevTurbine owning it is planned, not shipped |
| A qualifier (Conversion / Expansion, Retention) | Nothing once billing is connected — qualifiers are conditions RevTurbine derives itself, payment signals included. Before billing connects, set `payment_failed` / `payment_at_risk` on the user context |
| A segment on activity state | Product events fired where they happen (`rt.track()`) — activity and its tiers derive from tracked events |

Field shapes come from `revturbine schema` (`UserContext`): traits go
under `custom`, trial state under `trial`, and the payment signals are
`payment_failed` and `payment_at_risk`. The id and plan rules — and
their traps — are taught in `revturbine-integrate-sdk` → "Set the user
context". Never improvise a name: `revturbine generate types
<playbook>` emits the Playbook's handles as typed constants —
entitlements, plans, segments, templates and CTA action types — so a
typo'd handle fails the build instead of silently never matching.
Generate the module once and import from it at every call site below.
(Event names are not covered: they are the app's own vocabulary, with
no Playbook source of truth.)

Where your human asks in product language instead, translate — for
example:

| The ask | The wiring | Worked example in the docs |
|---|---|---|
| Padlock a premium feature | Gate, both halves | Tutorials → Gate a premium feature |
| Navbar upgrade button | Slot + CTA handler | Tutorials → Upgrade button |
| Visible usage meter | Slot + usage reporting | Tutorials → Usage quota meter |
| "80% used" warning banner | Slot + usage reporting | Tutorials → Banner placement |
| "Buy credits" when low | Slot + CTA handler + reporting | Tutorials → Low-credits warning |
| Trial-ending nudge | Slot + trial reporting | Tutorials → Trial-ending nudge |
| Payment-failed recovery | Slot + payment signals | Tutorials → Payment recovery |
| Replace `user.plan === 'pro'` checks | A gate per call site | Guides → Migrate plan checks |

The tutorials carry the worked code. Where a tutorial and the installed
package's own types disagree on a prop or call shape, **the types win**
— check them before copying.

**No Playbook yet?** That is normal — wiring often comes first. Agree
the slot set and their ids with your human (the first column above is a
good default set), wire them empty, and record the ids in the notes file
(`revturbine-playbook-notes.md`, at the repo root beside the Playbook —
create it if `revturbine-author-playbook` has not) so
`revturbine-author-playbook` targets them later. Empty slots are safe:
they render nothing until a Playbook fills them. A gate's id is the one
exception to auto-discovery — it registers only when a denial first
occurs — so record gate ids in the notes rather than waiting for them to
appear.

## Gate a feature

A gate has two halves, and only both together protect anything.

**The screen half** decides what the user sees. Wrap each of the
feature's call sites (`<Gate id="…" can="entitlement_handle">`) — a
feature used in three places needs three gates: the children — the
existing UI, unchanged — render when entitled; on denial the gate
renders the matching gate placement from the Playbook, or the static
`deniedFallback` you supply when none matches. **Supply `deniedFallback`
on every gate**: without it, a denial with no matching placement renders
nothing — a feature that disappears with no upgrade path. Hosted mode
adds a server-side catch-all gate behind that; local mode has none.

Where the app already has hand-written checks (`user.plan === 'pro'`),
replace them with gates one call site at a time — those checks are what
RevTurbine exists to remove (worked example: Guides → Migrate plan
checks). For an action rather
than UI — a button handler, a submit — gate the function instead
(`rt.gate(action, fn)` / `useGatedAction`), which runs it only when
entitled. Unlike `<Gate>`, the function form renders nothing on denial —
when it reports `ran: false`, render the gate placement for that
entitlement yourself.

**The trap in the screen half:** a user who is running low comes back
`limited`, and **limited is still allowed** — the children render.
Omitting `limitedFallback` is the safe default. If you supply one, it
replaces the children rather than sitting beside them, so it must
re-render the feature as well as the warning — a warning alone locks out
a user who is paying you. Check every gate in the app agrees on this.

**The backend half** protects the value. Anything a user can gain by
editing browser state — an export that costs compute, a credit spend, a
seat — is re-checked on the backend before the value is delivered, using
the server SDK for that language (`revturbine-start-here` → Determine
the current RevTurbine state routes this). Where the backend language
has no server SDK, record the gap as a launch risk — never fake the
check. A purely cosmetic gate can skip the backend half; anything
costly cannot.

## Render the slots

Slot wiring is two different jobs. **Fixed placements name their slot
id** — wire a slot at each id the work order lists (`<Slot id="…">`).
**RevTurbine-initiated placements match by surface type**, not by id: a
usage warning authored on a banner template renders at any slot that
declares the banner type. So also wire a general set covering the
surface types this Playbook's payloads use — typically a banner, a
toast, and a modal opportunity — and nudges authored later land in them
with no new wiring. Slot ids are discovered automatically the first time
the app requests them; there is no registration step, so the id in code
and the id the Playbook targets simply have to match. **That makes
determinism the rule: a slot id is a fixed string in code** — never
derived from runtime state, a render counter, or the user — or the
Playbook targets an id that exists nowhere and discovery fills the
dashboard with one-off ghosts.

- **An empty slot renders nothing.** That is the designed behavior, not
  an error; supply the `fallback` prop where the page needs a baseline
  instead of absence.
- **Pick the component from the gallery.** The docs' Component Gallery
  demonstrates the common built-in slot components live — banner, modal,
  toast, button, quota meter, in-page card — and the package registers
  more (tooltip, trial counter and credit balance among them). A custom
  design follows the docs' Custom Slots guide.
- **Dismissal is wired for you.** The built-in components report
  dismissal from their own close controls; you add nothing. A
  snooze/remind-me-later control is not built into any of them — offer
  it only by rendering your own component (the `snooze` control on
  `usePlacement()`).
- **Modals earn their interruption.** Request a modal slot only after a
  user action, on completion, or at a natural transition — never on
  passive page render. Banner, in-page, button and toast are safe on
  render.

## Handle the CTA clicks

A CTA path is an intent — open checkout, view plans, contact sales, book
a demo, open another placement. RevTurbine supplies the intent; **the
app executes it**, through the resolver map the provider was given at
mount (`uiPathResolvers`, established by `revturbine-integrate-sdk`).

Give every action type the Playbook declares a real body. Coverage is
enforced for you: the SDK refuses to initialize when a declared type has
no resolver, and names the missing type in its error — read that rather
than auditing by hand (`validateUiPathResolvers()` runs the same check
on demand). Key the map by the exact action-type values in `revturbine
schema` (`ContentUiPath.action_type`); the authoring-side CTA-path enum
is a different list with similar names, and keys from it fail the init
check. For a click that reaches no resolver anyway, the slot's
`onCtaClick` prop is the last resort.

Checkout needs somewhere to send the user. If the app already has its
own checkout, wire `open_checkout` to it now — the resolver receives the
plan handle; the app maps it to its own price.
`revturbine-connect-billing` does not build checkout: it links
RevTurbine to Stripe — prices mapped to plan variations, and Stripe's
events flowing back into RevTurbine. Once billing is connected, a
purchase updates the plan by itself; until then, **the app updates the
user's plan after a purchase** (`rt.update()`). With no checkout at all
yet, stub the intent to the plans page.

## Report back

Nothing in this section renders, and every missed item fails silently —
check it as carefully as the visible work.

### User context

Everything decisions read about the user lives here: plan, balances,
traits, trial state, payment signals. All of it changes through one
verb: `rt.update()` accepts the whole user context except the id —
`rt.update({ usage: { generations: 25 } })`, a plan change, a trait —
while a change of *who* is `identify()` at sign-in. Two rules keep it
fresh:

- **Send the new value the moment the fact changes** — a consumption, a
  plan change, a trait.
- **Re-send before any screen that depends on a fact that can change
  elsewhere** — another device, a server job, a billing webhook.

A stale or mis-keyed context misleads the user but never over-grants:
display reads the client context; enforcement reads the app's own
records through the gate's backend half. **A metered entitlement with no
reported balance reads as zero used** — the limit never bites, silently.
The usual cause is a typo'd key: the balance lands under a name no
entitlement owns, and the real handle stays at zero. Report against the
generated typed handles rather than string literals and that typo is a
build error instead.

The app supplies these fields, with two exceptions RevTurbine derives
itself once billing is connected: the plan, and the payment signals.
Either way everything lives in the same user context — decisions
always read one place — and **an unsent field is silence, not a
default**.

### Events

An append-only record of what the user did, fired at the moment it
happens (`rt.track('project_created')`) — nothing to keep current. Two
things run on them: the activity segments, where any tracked event
counts as activity, and the funnels your human reads in the dashboard.

Fire the actions that show a user engaging with the product and getting
value — often the same actions worth gating, and breadth helps: the
activity tiers read more faithfully the more of the product's real
actions are reported. Do not mirror the app's whole analytics stream,
and fire none of RevTurbine's own monetization events — impressions,
CTA clicks and gate outcomes are tracked automatically. Events qualify
nothing on their own; placements run on gate denials, thresholds, trial
milestones and qualifiers.

## Prove each piece as you go

One check per change, at the moment you make it — not a sweep at the
end:

- **A gate**: both states observed. Flip the user's plan and see the
  feature, then the upgrade path. If the entitlement can come back
  `limited`, observe that too.
- **A slot**: content renders when a placement matches, and the page is
  its normal self when none does.
- **A CTA handler**: click it; the intended thing happens. An unknown
  type reaches the fallback.
- **Reporting**: evaluate the entitlement just over its limit and
  confirm a refusal — the just-over case is where a mis-keyed balance
  shows itself.
- **Pacing**: the Playbook's caps, cooldowns and trial triggers are
  enforced by the SDK — read what the running instance believes
  (`getPolicy()`) rather than assuming.

Where the repo has a test suite, keep the highest-value checks as
tests: the entitled and denied paths of each gate, the baseline render
when a slot is empty, one limit asserted just over its boundary, and
the backend re-check on each revenue-critical action.
`revturbine-verify-integration` specifies tests in exactly this shape —
when it hands you a list, this is where they get built.

Then tell your human, briefly, what is now live in the app and what the
Playbook can change without a deploy.

## When the Playbook changes

Most Playbook edits need no code — copy, targeting, thresholds, limits,
prices, pacing, new payloads on already-wired surface types, and whole
new placements landing in the general slots all reach users with no
deploy. The wiring above is what makes that promise hold.

An edit needs new wiring only when it adds a row to the work order: a
first gate on a previously ungated feature, a new trait, a new balance
key, a new CTA action type, a new Fixed slot id.
`revturbine-author-playbook` records these in the notes file as it makes
them. When a changed Playbook reaches you, re-derive the work order and
wire the delta — same rhythm, one call site at a time — and tell your
human which part of their edit shipped instantly and which needed this
change.

## Where to go next

- **Change what is charged for or shown** —
  `revturbine-author-playbook`; the wiring you built stays put.
- **Real checkout and prices** — `revturbine-connect-billing`.
- **Audit the whole integration** — `revturbine-verify-integration`,
  before any launch.
- **Go live** — `revturbine-release-lifecycle`.

## If you get stuck

Component props and worked examples are in the docs at
`https://revturbine.com/docs` (the Component Gallery, and the tutorials
named in the table above); field shapes come from
`revturbine schema`; command syntax from `revturbine <command> --help`,
never from memory. For anything else, follow `revturbine-start-here` →
If you get stuck.
