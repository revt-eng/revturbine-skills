---
name: revturbine-monetization-best-practices
description: >
  Advises first-pass pricing, packaging and monetization for a RevTurbine
  Playbook when little or no usage data exists — entry model, what to
  gate, tiers, prices, limits, trials, and upgrade placements. Advisory
  and read-only; `revturbine-author-playbook` draws on it. Load it
  directly for judgement calls like "should we do a free trial or a free
  plan", "what should we charge for", "subscription or usage or
  credits", "is this a good free tier", "where should the upgrade prompt
  go", "how do we set our limits", or "can we raise prices or tighten
  limits later". Once real traffic exists,
  decisions move to RevTurbine's optimization. Load revturbine-start-here
  first if this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.8.1"
  safety_class: read-only-inspection
  schema_version: ">=0.1.0 <0.2.0"
  tier: free
---

# RevTurbine — Monetization Best Practices

You are an experienced product-led growth, pricing and packaging advisor.
Use that expertise; this skill carries only what you cannot get from
general practice — where RevTurbine's view is more specific, and what
the platform supports. It advises a **first setup with little or no
data**: one your human understands, that fits their product, and that
stays cheap to change. The mechanics — the seven entitlement types,
trials, the six placement categories, caps and cooldowns — are in
**`revturbine-start-here/references/monetization-model.md`**; read it
first if you have not.

**Scope:** subscription tiers and add-ons — including **hybrid** setups
where a subscription base carries a usage or credit component, the
dominant shape among fast-growing SaaS (58% blend recurring plans with
usage or credits; only 12% run pure subscription —
`https://revturbine.com/resources/fastest-growing-saas`). **Pure
usage-based billing** fits a specific product type where consumption
*is* the product, usage tracks value tightly, variance defeats any
tier, and the buyer accepts a variable bill. Examples: cloud and dev
infra. If that describes the product, say so plainly — RevTurbine
still handles its entitlements and nudges, but the billing design sits
mostly outside this skill.

**Ground in their context before applying any of this.** Every default
below is wrong against the wrong objective. Establish first: what this
setup should optimize for right now (adoption, revenue, learning), what
already exists (published prices, promises made, a live free tier), and
what is off the table. Inside the authoring flow,
`revturbine-author-playbook`'s Step 2 gathers this — don't duplicate it;
loaded standalone, ask first.

Two things to hold throughout. **Simple and understood beats clever and
opaque.** And **build so it can move**: most numbers here will be wrong
at first, so the goal is a structure that keeps them cheap to change.

## Choose the entry model — free plan, free trial, or both

The decision runs on four things: **time-to-value** (value in the first
session favors a trial; value that builds over weeks favors a free
plan), **marginal cost** (near-zero cost-to-serve makes an open free
plan affordable; real per-use cost means caps or a time box), **market
breadth** (a wide market with a sharing loop rewards a free plan as the
acquisition engine; a narrow ICP evaluating deliberately suits a
trial), and **who buys** (bottom-up adopters try; a buyer on a timeline
evaluates). The full-funnel comparison is at
`https://revturbine.com/resources/freemium-vs-free-trial`.

- **Default: a free plan plus an opt-in trial of a paid tier** for
  product-led products — no either/or needed, and it is how RevTurbine
  models things anyway: the free plan is a plan, the trial a trial
  object on a paid one.
- **A free trial alone** when value shows inside the trial window and an
  open free plan is unaffordable (real marginal cost per user) or
  unnecessary (a narrow ICP evaluating deliberately). A card-required
  trial converts far higher per signup and cuts signups hard — for
  high-intent traffic, not a broad product-led motion. It also fits when
  evaluation itself demands real commitment — sustained participation,
  meaningful setup, data import, or workflow change.
- **A reverse trial** — everyone starts with paid features, then
  auto-downgrades to free — when premium value only shows through use.
  Minority practice but growing; RevTurbine supports it natively.

## Read the market first

Read **three to five direct competitors' pricing pages** — or, with no
direct competitor, **two or three analogous businesses** sharing the
same buyer and budget line; the analogs supply the pricing unit and the
budget ceiling. Extract four things from each: what customers pay by
(the pricing unit), the tier count and what gates each, the free
motion, and the price anchors. Conform on unit and motion by default —
buyers comparison-shop — and deviate only with a reason you can state.
Two cautions: a pricing page shows structure, not what anyone actually
pays; and copying imports the competitor's mistakes. The substitute the
customer pays for today is the real budget ceiling.

**Benchmarks set expectations; they don't make decisions.** Use them to
know what normal looks like — conversion rates, free-tier generosity,
price points — and to sanity-check a proposal; never copy a number into
config. Sources, fetched fresh: `https://revturbine.com/resources`,
Growth Unhinged (`https://www.growthunhinged.com/`) for conversion and
PLG data, Metronome's State of Usage-Based Pricing
(`https://metronome.com/`), and RevenueCat's State of Subscription Apps
(`https://www.revenuecat.com/`) — mobile apps, so translate with care.

## Choose what to gate

**Pick the metering unit — one default, three exceptions.**

- **Default: a per-period usage limit** on one repeated action that
  reasonably represents value (videos rendered, reports exported,
  meetings transcribed). It is met repeatedly, by someone already
  getting value — a better ask than a feature gate met once.
- **Credits** only when several valuable actions draw on one shared
  allowance at materially different rates, or customers need top-ups.
  Credits earn their complexity then, not before — how to run them is
  in "Design the ladder".
- **Seats** when value scales with collaborators or administrative
  scope — usually alongside usage or feature gates, rarely alone.
- **A feature gate** when value is binary, organizational, or not
  credibly measurable — SSO, audit logs, permissions, integrations.

**Keep the bill simple.** What customers pay by is the most
consequential choice on the page, and the bill should be explainable in
a sentence — a hybrid still passes that test. Skip the complex
mechanics at first: hard caps rather than overage charges, no true-ups
or tapered rates. Gates are not price dimensions: several gates and
limits are fine and useful; several numbers on the price tag are not.

**Gate on results where you can, and on value where you can't.** The
best limit meters the thing the user came for, because it rises with
the value they've received, so meeting it feels fair. Where the outcome
can't be counted, gate the capability they'd most miss — never
something merely convenient for you to count.

**Never gate table stakes — and never gate the activation path.** A
free tier that can't complete one useful piece of work doesn't convert,
it churns; a paywall met before the user has seen value converts
nobody. Most signups never reach activation at all — that, not the ask,
is usually the binding constraint. Gate the *next* thing they want, not
the thing they came for.

**Prefer per-period limits over lifetime caps.** "Ten per month" comes
around again; "ten ever" is spent once. The same rule governs AI
credits: a small *recurring* grant beats a one-time bucket — it caps
cost per period and gives each period a fresh conversion moment. For
genuinely persistent things — stored projects, dashboards — use a
**concurrent** limit, which counts active items, so deleting one frees
the slot.

**Soften the gate where you can.** Degrading a premium feature often
beats blocking it: the user experiences the premium thing, forms the
habit, and meets the limit again. Common levers: a weaker model or
fewer modes, lower usage, watermarks or resolution, batched instead of
real-time, lower priority, shorter history, read-only sharing, no API
or export, no SSO or audit logs.

**Multiple gates are fine — metering work is the constraint.** Every
metered entitlement is something the app must count and report
accurately, and a limit fed by a balance nobody reports is not
enforced. As many gates as they can meter honestly, and no more; where
the counting isn't there, use a feature gate, which needs none.

**Don't gate the sharing action itself.** Invites, view links and
collaboration are the acquisition loop. Gate collaboration *depth* —
roles, permissions, admin controls — and leave the door open.

## Design the ladder

**Three or four plans**: free, one or two paid, and — as soon as they
intend to serve larger organizations — an unpriced **Enterprise** tier,
even if its feature gap is thin. It sets positioning and gives sales
somewhere to route; any tier a user can't self-serve into routes to
contact-sales or book-demo, never to checkout. (74% of fast-growing
SaaS run a four-tier ladder; 86% keep an always-free plan.)

The **free tier** must contain the whole activation path, create a
habit, and let the user reach a real aha moment entirely on free.
**Pick generosity that makes a strong marketing claim — and be prepared
to support it.** "Unlimited free viewers" or "500 free credits every
month" acquires users in a way thin generosity spread everywhere never
does; a claim like that is a commitment, so make ones you can afford to
keep. Skip the free plan in two situations: the product's whole value
is delivered in a single use — a free plan there is a free product, so
use a trial or a one-time grant instead — or serving even a capped free
user costs real money the free tier's acquisition value won't repay.
It does not have to appear on the pricing page (see "Build so it can
move"), and once traffic exists, segmentation can cheapen it — smaller
grants for low-propensity signups.

**An add-on beats a new tier** when one distinct segment values the
capability, when its value is orthogonal to the good-better-best
ladder, or when it carries real marginal cost that shouldn't be priced
into every tier. An add-on prices at a fraction of the tier it attaches
to — much above that, the buyer should be upgrading — and a handful of
add-ons is a catalog; a dozen is choice paralysis.

**Where credits are the unit** (the AI norm): credits are **one
currency across features with very different underlying costs** — the
buyer holds one number while each action carries its own exchange
rate. Make the cheapest action one credit and price others as
multiples, anchored to the value of the step rather than its cost;
keep the per-action rates yours to adjust — that is the margin lever
when model costs move — and allow some rollover, which gives users a
balance to come back for.

## Set the numbers

Price against **results or value delivered, not cost** — the buyer
should see a multiple of what they pay, commonly three to five times (a
sanity check, not a formula), higher where the outcome carries risk.
The competitor and analog anchors set the credible *range*; value sets
the point within it. Discount annual by around twenty percent versus
monthly to pull cash forward and dampen churn. Use just-below prices.

**Size free limits and trial length so a typical engaged user reaches
the aha moment before the first ask** — the limit above the activation
threshold and below serious use. Trial length, as a heuristic with no
product evidence: **7 days** only when value appears in the first
session and use is frequent; **14 days** for typical self-serve SaaS;
**21–30 days** when evaluation needs setup, data import, team
coordination, or buyer review. Retune from activation and conversion
data.

Say plainly when a number is a guess. Where there's no source, offer
your human the choice between a reasoned proposal and an obvious
placeholder — never quietly invent one. For a sanity check from their
own end users, two questions get most of the way: what would count as
an acceptable price, and at what price would they have to think twice.

## Placements / nudges — build in category order

**Start by identifying the surfaces that matter for this product**:
where value is delivered, where a refusal can happen, the natural
transitions (post-save, post-export, onboarding end, cancel flow), and
the one or two places every user passes. That inventory — not the
category list — decides what gets built. Conversion rises with the
number of upgrade moments a user *walks into*; what stays low is
unprompted interruptions.

The build order is the category order. **Launch with 1–4; categories 5
and 6 are optimization passes added after launch**, one or two
placements at a time.

1. **Fixed** — the persistent entry points: the header upgrade action
   and the in-app plans page. They fire whenever their slot renders and
   are never capped.
2. **Access Gates** — one for every refusable entitlement, saying what
   the user hit and what to do about it. The highest-value work in the
   setup; finish all of them before anything else. (Hosted mode covers
   a skipped one with a generic catch-all — a wasted moment, and
   flagged in the dashboard.)
3. **Usage / Credit / Seat** — a warning ladder on each metered limit:
   one warning around 80% plus the gate at 100% is a good first setup;
   add a 50–60% informational touch only where the product can carry
   it. Three touches is the maximum.
4. **Trials** — where a trial exists, a short ladder weighted to the
   end, where intent is real: an orientation at the start, an
   ending-soon notice carrying the upgrade path, and the conversion ask
   at expiry.
5. **Conversion / Expansion** *(post-launch optimization)* — each tied
   to a qualifying condition, never a scheduled blast: work-email
   capture on personal-email signups, overage-vs-upgrade where credits
   are billed, teammate invite / referral, a stalled-onboarding nudge,
   a recommended plan at the first ask. These lean on CTA paths and
   signals the app may not have wired yet; none blocks going live.
6. **Retention** *(post-launch, once billing is connected)* — payment
   recovery and the backup-payment prompt first: transactional, not
   promotional — a persistent banner through the grace period is fine
   where an upgrade ad would not be, but with at-risk users one clear
   offer matched to the reason, at most a second from a different
   angle. Then an annual-billing nudge to established customers on
   monthly billing.

Every placement needs a trigger; every payload needs content and
usually a CTA path. Content that says "Upgrade" without saying what
they get is a wasted moment.

## Pace what RevTurbine initiates

Pacing applies only to the RevTurbine-initiated categories — Usage /
Credit / Seat, Trials, Conversion / Expansion, Retention. Fixed
placements and Access Gates are exempt: the user walked into those
moments, and capping a gate doesn't fix "too many prompts".

- **Repeated identical prompts have diminishing returns.** Starting
  defaults for interruptive surfaces: at most once per session and
  roughly once per week per payload, with a lifetime cap on anything
  that only makes sense once. Passive surfaces (banners, inline)
  tolerate persistence only when they look native to the product.
- **Vary the message, not just the frequency.** The warning ladder's
  steps already differ by design; where the same moment recurs — a
  per-period limit met again each month — let a capped Conversion /
  Expansion placement carry a second voice (an overage-vs-upgrade case,
  an offer) rather than repeating the warning.
- **A dismissal is an answer.** After dismissal or repeated exposure,
  extend the cooldown or change the message or offer. RevTurbine
  enforces the mechanics: dismissing or clicking starts the cooldown,
  converting retires the payload, and "remind me later" re-asks when
  the user chose. The only same-session follow-up to a "no" is a
  *different* offer.
- **Ask after action, not on arrival.** Prompts at a workflow seam —
  task completed, limit met, feature discovered — convert; prompts on
  page-load train dismissal.

Set caps deliberately on every payload that can carry them, and read
what the running setup enforces from the dashboard rather than
assuming.

## Build so it can move

**Treat published prices and entitlements as customer promises.**
Prefer changes that loosen limits, add value, or add a higher tier
above an untouched anchor; never tighten terms retroactively. Raise
list price rarely and properly — with notice, effective at renewal, an
early-renewal lock for existing customers, and attached to shipped
value. Never say "unlimited" about anything with real per-use cost: on
a near-zero-cost dimension (viewers, links, projects) it is a powerful
claim; on consumption it is a promise you will one day meter.

The record behind that doctrine is consistent. Cheap corrections:
raising a limit, cutting a price, adding a premium tier above an
untouched anchor (Notion's free-tier uncapping; the $20 AI
subscriptions growing $100–200 tiers). Expensive ones: lowering a
published free entitlement, metering a promised "unlimited", anything
retroactive, and a big raise combined with repackaging in one move
(Evernote, Cursor, Unity, Netflix 2011).

That asymmetry leaves two deliberate postures — pick one and say which:

- **Start at the conservative end, and don't publish what you want to
  test**: price toward the high end of what's defensible, publish tight
  hard limits you intend only to raise, and keep the rest unlisted —
  not every limit needs a number on the pricing page, the free plan
  doesn't have to be listed, and an unlisted plan is the cleanest way
  to test a package. Loosening is painless; tightening costs trust.
- **Start cheap or generous to buy adoption — with a migration playbook
  ready**, so the eventual move up is a planned option rather than a
  crisis. Prefer self-expiring commitments first (a time-boxed
  promotion, an early-renewal lock). For a real change: move affected
  customers onto a `legacy` plan, notify them with the date and what
  changes, then converge at the deadline — onto a live plan, or one
  consolidated grandfathered plan with loyalty pricing. One destination
  and a date, so the plan catalog stays simple instead of accumulating
  a legacy cohort per change.

And keep monetization out of the application code: plans, limits, gates
and prompts live in the Playbook so changing them needs no deploy —
which is what makes any of this iterable.

## When this stops being the right guide

Everything above is for **before there is evidence**. Once real traffic
exists, these questions — structure included, not just the numbers —
are answered from the live analytics in the dashboard, with
experimentation and optimization tooling coming on the Growth plan; say
so plainly and point there.

## If you get stuck

The model's semantics are in
`revturbine-start-here/references/monetization-model.md`; field shapes
are answered by `revturbine schema`; the concepts are covered in the
docs (`https://revturbine.com/docs/llms-small.txt` is the page map).
Otherwise follow `revturbine-start-here` → If you get stuck.
