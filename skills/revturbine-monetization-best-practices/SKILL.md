---
name: revturbine-monetization-best-practices
description: >
  RevTurbine's guidance on designing a monetization setup — which pricing
  model, what to charge for, how to package it, what to gate, where to
  ask for the upgrade. Advisory and read-only: it shapes decisions, it
  does not write config. Use when authoring or changing a Playbook and
  the question is a judgement call rather than a mechanical one — free
  plan or free trial, subscription or usage-based, how many plans, what
  belongs on the free tier, which limits, where the paywall goes, how
  often to nudge. `revturbine-author-playbook` draws on this; load it
  directly when someone asks "what should we charge for", "how should we
  package this", "should we do a free trial or a free plan", "is this a
  good free tier", "where should the upgrade prompt go", or "how do we
  set our limits". Aimed at a first setup with no usage data yet; once
  real traffic exists, decisions move to RevTurbine's optimization. Load
  revturbine-start-here first if this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.7.1"
  safety_class: read-only-inspection
  schema_version: ">=0.1.0 <0.2.0"
  sdk: "^0.2.77"
  tier: free
---

# RevTurbine — Monetization Best Practices

You are an experienced product-led growth, pricing and packaging advisor.
Use that expertise. This skill does not restate it — it carries what you
cannot get from general practice: where RevTurbine's view is more
specific than the general playbook, and what the platform supports.

**Scope:** this skill designs **subscription tiers and add-ons** — the
model RevTurbine recommends and most fully supports, because it gives
buyers cost certainty — including **hybrid** setups where a subscription
base carries a usage or credit component. Hybrid is now the modal
structure in SaaS and the overwhelming norm for AI products, where
credits meter real inference cost. **Pure usage-based billing** is the
right call only in a narrow band: infrastructure-like products and
developer APIs where consumption *is* the product, usage tracks value
tightly, variance across customers is too high for any tier to fit, and
the buyer is technical and accepts a variable bill. If that describes
the product, say so plainly — RevTurbine still handles its entitlements
and nudges, but the billing design sits mostly outside this skill.

Focus is a **first setup, with no RevTurbine data yet** — one your human
understands, that fits their product, and that can be changed later
without a rewrite. The mechanics — the seven entitlement types, trials,
the six placement categories, caps and cooldowns — are in
**`revturbine-start-here/references/monetization-model.md`**. Read it
first if you have not. This file is judgement only.

**Ground in their context before applying any of this.** Every default
below is wrong against the wrong objective. Establish first: what this
setup should optimize for right now (adoption, revenue, learning),
what already exists (published prices, promises made, a live free
tier), and what is off the table. Inside the authoring flow,
`revturbine-author-playbook`'s Step 2 gathers this — don't duplicate
it; loaded standalone, ask first.

Two things to hold throughout. **Simple and understood beats clever and
opaque.** And **build so it can move**: most numbers here will be wrong
at first, so the goal is a structure that keeps them cheap to change.

## Choose the entry model — free plan, free trial, or both

The decision runs on four things: **time-to-value** (value in the first
session favors a trial; value that builds over weeks favors a free
plan), **marginal cost** (near-zero cost-to-serve makes an open free
plan affordable; real per-use cost — inference, compute, storage —
means caps or a time box), **market breadth** (a wide end-user market
with a sharing loop rewards a free plan as the acquisition engine; a
narrow ICP evaluating deliberately suits a trial), and **who buys**
(bottom-up adopters try; a buyer on a timeline evaluates).

- **A free plan plus an opt-in trial of a paid tier** is the safest
  default for product-led products and needs no either/or decision —
  and it is how RevTurbine models things anyway: the free plan is a
  plan, the trial is a trial object on a paid one.
- **A free trial alone** is right when value shows inside the trial
  window and an open free plan is either unaffordable (real marginal
  cost per user) or unnecessary (a narrow ICP that evaluates
  deliberately). A card-required trial converts far higher per signup
  and cuts signups hard — for high-intent traffic, not a broad
  product-led motion.
- **A reverse trial** — everyone starts with paid features, then
  auto-downgrades to free — is the strongest pattern when premium value
  only shows through use. Still minority practice, but growing, and
  RevTurbine supports it natively.

## Read the market first

Before designing anything, read **three to five direct competitors'
pricing pages** — and where no direct competitor exists, **two or
three analogous businesses** that share the same buyer and budget
line; the analogs supply the pricing unit and the budget ceiling.
Extract four things from each: **what customers pay by** (seats,
usage, credits — the pricing unit), the tier count and what gates
each, the free motion, and the price anchors. Conform on unit and
motion by default — buyers comparison-shop — and deviate only with a
reason you can state. Two cautions: a pricing page shows structure,
not what anyone actually pays; and copying imports the competitor's
mistakes. The substitute the customer pays for today is the real
budget ceiling.

**Benchmarks set expectations; they don't make decisions.** Use them
to know what normal looks like — conversion rates, free-tier
generosity, price points for the category — and to sanity-check a
proposal. Never copy a number into config: benchmarks average away
exactly the context that matters. Sources, fetched fresh rather than
quoted from memory: **`https://revturbine.com/resources`**
(RevTurbine's guides and digests), Growth Unhinged
(`https://www.growthunhinged.com/`) for conversion and PLG data,
Metronome's State of Usage-Based Pricing (`https://metronome.com/`),
and RevenueCat's State of Subscription Apps
(`https://www.revenuecat.com/`) — mobile apps, so translate with
care.

## Choose what to gate

**Keep the bill simple.** What customers pay by is the most
consequential choice on the page, and the bill should be explainable
in a sentence — a hybrid (subscription base plus a credit or usage
component) still passes that test. Skip the complex mechanics at
first: hard caps rather than overage charges, no true-ups or tapered
rates — add them only when the data argues for them. And gates are
not price dimensions: several gates and limits are fine and useful
(below); several numbers on the price tag are not.

**Gate on results where you can, and on value where you can't.** The
best limit meters the thing the user came for — videos rendered,
reports exported, meetings transcribed — because it rises with the
value they've received, so meeting it feels fair. Where the outcome
can't be counted, gate the capability they'd most miss. Never gate on
something that is merely convenient for you to count.

**Never gate what is table stakes for that tier's job — and never gate
the activation path.** A free tier that can't complete one useful piece
of work doesn't convert, it churns; a paywall met before the user has
seen value converts nobody. Most signups never reach activation at all
— that, not the ask, is usually the binding constraint. Gate the *next*
thing they want, not the thing they came for.

**Usage gates generally outperform feature gates.** A feature gate is
met once, by someone who may not yet care. A usage limit is met
repeatedly, by someone already getting value — a much better moment to
ask.

**Prefer per-period limits over lifetime caps.** "Ten per month" comes
around again; "ten ever" is spent once, leaving no new moment to
convert on. The same rule governs AI credits and usage grants: a small
*recurring* grant beats a one-time bucket — it caps cost per period
and keeps unconverted users coming back, each period a fresh
conversion moment. For genuinely persistent things — stored projects,
dashboards — use a **concurrent** limit, which counts active items
rather than cumulative ones, so deleting one frees the slot.

**Soften the gate where you can.** Degrading a premium feature at a
lower tier is often better than blocking it: the user experiences the
premium thing, forms the habit, and meets the limit again. Common
levers — a weaker model or fewer modes; lower usage; watermarks or
lower resolution; slower or batched instead of real-time; lower
priority; narrower scope; shorter history; read-only sharing; manual
instead of scheduled; no API or export; no SSO or audit logs.

**Multiple gates are fine — metering work is the constraint.** Several
smaller gates give more places to tune and more upgrade moments. But
every metered entitlement is something the app must count and report
accurately, and a limit fed by a balance nobody reports is not enforced
at all. As many gates as they can meter honestly, and no more; where
the counting isn't there, use a feature or capability-tier gate, which
needs none.

**Don't gate the sharing action itself.** Invites, view links and
collaboration are the acquisition loop. Gate collaboration *depth* —
roles, permissions, admin controls — and leave the door open.

## Design the ladder

**Three or four plans**: free, one or two paid, and — as soon as they
intend to serve larger organizations — an unpriced **Enterprise** tier,
even if its feature gap is thin. It sets positioning and gives sales
somewhere to route; any tier a user can't self-serve into routes to
contact-sales or book-demo, never to checkout.

The **free tier** should be genuinely useful: it must contain the whole
activation path, create a habit, and let the user reach a real aha
moment entirely on free. **Pick generosity that makes a strong
marketing claim — and be prepared to support it.** "Unlimited free
viewers" or "500 free credits every month" acquires users in a way
thin generosity spread everywhere never does; a claim like that is a
commitment, so make ones you can afford to keep. An always-free plan
is the norm among high-growth SaaS. Skip it in two situations: the
product's whole value is delivered in a single use (a one-off report,
an analysis, a conversion) — a free plan there is a free product, so
use a trial or a one-time grant instead; or serving even a capped
free user costs real money the free tier's acquisition value won't
repay. It does not have to appear on the pricing page (see "Build so
it can move"), and once traffic exists, segmentation can cheapen it —
smaller grants for low-propensity signups.

**An add-on beats a new tier** when one distinct segment values the
capability, when its value is orthogonal to the good-better-best
ladder, or when it carries real marginal cost that shouldn't be priced
into everyone's tier. Rough discipline: an add-on prices at a fraction
of the tier it attaches to — much above that, the buyer should be
upgrading instead — and a handful of add-ons is a catalog; a dozen is
choice paralysis.

**Where credits are the unit** (the AI norm): the point of credits is
**one currency across features with very different underlying costs**
— a chat turn, a render, an enrichment all draw on the same balance,
so the buyer holds one number while each action carries its own
exchange rate. Make the cheapest action one credit and price other
actions as multiples, anchored to the value of the step rather than
its cost; keep those per-action rates yours to adjust — that is the
margin lever when model costs move — and allow some rollover, which
reduces churn by giving users a balance to come back for.

## Set the numbers

Price against **results or value delivered, not cost** — the buyer
should see a multiple of what they pay, commonly three to five times
(a sanity check, not a formula), higher where the outcome carries
risk. The competitor and analog anchors from "Read the market" set
the credible *range*; value sets the point within it. Discount annual
by around twenty percent versus monthly to pull cash forward and
dampen churn. Use just-below prices.

**Size the free limits and trial length so a typical engaged user
reaches the aha moment before the first ask.** Monetization placed
before activation compounds the biggest leak in the funnel — most
signups never activate at all. The limit sits above the activation
threshold and below serious-usage level; the trial runs comfortably
longer than typical time-to-value. Both get re-tuned once there's data.

Which numbers stay cheap to change is a design property of the setup,
not luck — that is "Build so it can move", below.

Say plainly when a number is a guess. Where there's no source, offer
your human the choice between a reasoned proposal and an obvious
placeholder — never quietly invent one. If they want a sanity check
from their own end users, two questions get most of the way: what would
count as an acceptable price, and at what price would they have to
think twice.

## Placements / nudges

**Start by identifying the surfaces that matter for this product.**
Before configuring anything, list the moments monetization can
honestly speak into: where value is delivered, where a refusal can
happen, the natural transitions (post-save, post-export, onboarding
end, cancel flow), and the one or two places every user passes. That
inventory — not the category list — decides what gets built.

**More asks in context means more conversions.** Conversion rises with
the number of upgrade moments a user actually *walks into*; the number
to keep low is unprompted interruptions. So the first setup covers
every refusal and the always-on surfaces before building one perfect
paywall.

**Fixed placements** are the always-present ones wired into the product
— a header upgrade button, the in-app plans page, a post-signup
moment, the cancel flow. They fire whenever their slot renders for a
matching user and are never capped. Start with the header button and
the plans page.

**Give every refusable entitlement an upgrade path.** For each
entitlement a user can click into and be refused, configure an Access
Gate placement that says what they hit and what to do about it. This is
the highest-value work in the setup — do all of them before adding
anything else. Skipping one does not leave a silent block in hosted
mode — a catch-all gate fires with generic copy — but generic copy is a
wasted moment, and a hard-block entitlement with no placement of its
own is flagged in the dashboard.

**Warn before you block.** For each usage, credit or seat limit, build
a short ladder rather than a single wall, weighted to the back end
where the intent is real: an informational touch around 50–60%, a soft
prompt with an easy route around 80%, and at 100% the limit-reached
alert plus the Access Gate on the refused action. Three touches is a
maximum; one warning at 80% plus the gate is a perfectly good first
setup, and quieter.

**The second wave — Conversion / Expansion and Retention placements.**
Everything above is the first launch; these are best framed as the
first *optimization pass after it* — they lean on CTA paths and
signals the app may not have wired yet, and none of them blocks going
live. When their turn comes, they earn their place one or two at a
time, each tied to a qualifying condition or segment — never a
scheduled blast:

- The highest-value Conversion / Expansion picks: **work-email
  capture** on personal-email signups (offer a bigger grant for a work
  email — it feeds targeting and sales routing) and
  **overage-vs-upgrade** where credits are billed (when overage cost
  passes the upgrade price, saying so converts and builds trust). Then
  **invite-a-teammate / referral** as passive affordances with at most
  an occasional prompted ask, and **onboarding nudges** for users
  stalled short of activation — worthwhile when activation is the
  bottleneck, since an unactivated user converts to nothing. Seasonal
  promotions are time-bound by design; use them as the cheap
  alternative to a price cut.
- Retention's non-negotiable pair, as soon as billing is connected:
  **payment recovery** (payment failed) and a **backup-payment
  prompt** (payment at risk) — they read RevTurbine's payment signals
  and recover revenue otherwise silently lost. These are
  transactional, not promotional: a persistent banner through the
  grace period is fine where an upgrade ad would not be. One caution
  the research supports: with *at-risk* users, more contact is not
  better — over-prompting someone wavering can remind them to cancel.
  One clear offer matched to the reason, a second from a different
  angle at most.
- **Aim at the right plan at the first ask** belongs to the same
  pass: one recommended plan converts better than the full ladder —
  set the payload's recommended plan rather than leaving it to the
  default strategy.

Every placement needs a trigger, and every payload needs content and
usually a CTA path (informational touches may have none). Content that
says "Upgrade" without saying what they get is a wasted moment.

## Pace what RevTurbine initiates

Pacing separates a product that monetizes from one that nags, and it
applies only to the RevTurbine-initiated categories — Usage / Credit /
Seat, Trials, Conversion / Expansion and Retention. Fixed placements
and Access Gates are exempt by design: the user walked into those
moments, and you cannot solve "too many prompts" by capping a gate.

What the evidence says, and how to use it:

- **Attention to a repeated identical prompt collapses by the second
  exposure** — this is measured, not folklore. The defense is variation
  as much as frequency. In RevTurbine that is an authoring move: the
  warning ladder's steps already differ by design, and where the same
  moment will recur — a per-period limit met again each month — let a
  capped Conversion / Expansion placement carry the second voice (an
  overage-vs-upgrade case, an offer) instead of repeating the same
  warning.
- **Cap interruptive surfaces hard.** The consensus practice for modals
  and other interruptions: at most once per session and roughly once
  per week per payload, with a lifetime cap on anything that only makes
  sense once. Passive surfaces (banners, inline) tolerate persistence
  only when they look native to the product, not like promotion.
- **A dismissal is an answer.** Respect it with a real cooldown and
  back off further on repeat dismissals; RevTurbine enforces this for
  you — dismissing or clicking a payload starts its cooldown,
  converting retires it, and "remind me later" re-asks when the user
  chose. The one accepted same-session follow-up to a "no" is a
  *different* offer, never the same prompt again.
- **Ask after action, not on arrival.** Prompts landed at a workflow
  seam — task completed, limit met, feature discovered — convert;
  prompts on page-load train dismissal.

Set caps deliberately on every payload that can carry them, and read
what the running setup actually enforces from the dashboard rather than
assuming.

## Build so it can move

The record of the most successful SaaS companies is consistent about
**which corrections are cheap and which are the disasters** — design
the setup so the corrections you'll need are the cheap kind.

The cheap corrections, all well-rehearsed by the winners: **raising a
limit** (the only pricing change that generates positive press —
Notion uncapping its free tier); **cutting a price or segmenting
down**; **adding a premium tier above an untouched anchor** (how the
$20 AI subscriptions grew $100–200 tiers without touching $20); and
**raising list price done properly** — rarely (Slack held its price
~8 years, Figma ~7), with notice, effective at renewal, an
early-renewal lock for existing customers, and attached to shipped
value.

The expensive corrections supply every cautionary tale: **lowering a
published free entitlement** (Evernote's device cap), **turning
"unlimited" into metered** after the fact (Cursor's 2025 apology),
**tightening limits that were never quantified** (soft limits are a
stored liability — the backlash lands when you first enforce them),
**anything retroactive** (Unity's runtime fee — terminal), and **a
big raise combined with repackaging in one move** (Netflix 2011).
Where a tightening is truly unavoidable, the survivable pattern is
long notice, never retroactive, a bright-line threshold and a grace
period.

That asymmetry leaves two deliberate postures — pick one and say
which:

- **Start at the high end of what's defensible**: price up, publish
  tight hard limits you intend only to raise. Every correction you're
  likely to need is then the cheap kind.
- **Start cheap or generous to buy adoption — with a migration
  playbook ready**, so the eventual move up is a planned option
  rather than a crisis. Prefer self-expiring commitments first (a
  time-boxed promotion, an early-renewal lock). For a real change:
  move affected customers onto a `legacy` plan (it keeps serving
  them, off the pricing page), notify them with the date and what
  changes, then converge at the deadline — onto a live plan, or onto
  one consolidated grandfathered plan with "loyalty" pricing that
  honors tenure. One destination and a date; what kills companies is
  an open-ended cohort per change, compounding for years.

Either way, never say "unlimited" about anything that costs you per
use. On a near-zero-cost dimension — viewers, links, projects — it is
a powerful claim; on consumption it is a promise you will one day
meter, which is where the apologies come from. Make generosity an
explicit named policy (fair-billing style), not an implicit habit
you'll have to revoke.

The working rules that follow:

- **Don't publish what you want to test.** A public promise is the
  most expensive thing to walk back — not every limit needs a number
  on the pricing page, the free plan doesn't have to be listed, and a
  trial can run on an unlisted plan rather than promising a named
  tier.
- **Prefer removing a gate over adding one.** Loosening is painless;
  tightening costs trust. Start tighter than feels comfortable and
  open up as you learn.
- **Use an unlisted plan for testing** — a plan that exists but isn't
  on the pricing page is the cleanest way to trial a different
  package, or to watch behavior under different limits before
  committing.

And keep monetization out of the application code. Plans, limits, gates
and prompts live in the Playbook precisely so changing them needs no
deploy — which is what makes any of this iterable.

## When this stops being the right guide

Everything above is for **before there is evidence**; it cannot know
which gates people hit, which prompts convert, or which limit is wrong.
Once real traffic exists, those questions — including changes to the
structure, not just the numbers — are answered from the live analytics
in the dashboard, with experimentation and optimization tooling coming
on the Growth plan. Say so plainly and point there; a confident answer
without evidence is worse than no answer.

## If you get stuck

The model and its semantics are in
`revturbine-start-here/references/monetization-model.md`; shape and
field questions are answered by `revturbine schema`; the concepts are
covered in the docs
(`https://revturbine.com/docs/llms-small.txt` is the page map). Otherwise follow `revturbine-start-here` → If you get
stuck.
