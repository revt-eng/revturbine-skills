# Playbook authoring rules

*Data-quality rules for `revturbine-author-playbook`. These encode the judgement that keeps
a Playbook clean, demo-ready, and launch-safe. Shapes and field names always come from
`revturbine schema` — these rules are about how to use them well. Distilled from
RevTurbine's internal demo-building practice.*

1. **Handles are lowercase with underscores** (`ai_credits`, never `ai-credits`), stable,
   and readable — app code references them forever. Name entitlements after the capability
   (`batch_export`), never the plan (`pro_features`): a plan-named handle turns every
   repackaging into a code change. Use customer-facing tier names verbatim for plan names
   ("Professional", not "Pro" if that's what their pricing page says).
2. **Order like a pricing page.** Plans lowest → highest tier; entitlements volume/usage
   first, then features, then enterprise. The Playbook reads like their pricing page.
3. **One entitlement per capability.** Binary access → a feature; levelled access → a
   capability tier. Never both for the same concept.
4. **Grant, don't deny.** Access exists only where a rule grants it — no matching rule
   means denied (`no_matching_entitlement_rule`) — and where several rules match, the most
   permissive wins, so a rule can never subtract access. Gate by granting on the tiers that
   have a feature. An explicit `enabled: false` feature rule is schema-valid and denies
   exactly as absence does — but prefer absence: the dashboard currently renders such a
   rule as granted, so it misleads anyone reading the UI. `revturbine init`'s starter
   Playbook ships one, so when you start from `init`, convert it to absence rather than
   leaving it.
5. **Filters widen when absent; grants must be explicit.** Plan and segment fields that
   *narrow* an audience — a rule's `segment_ids`, payload targeting, a trial rule's plan
   and segment — mean "everyone" / "all plans" when empty or null. The one exception is
   the grant itself: an entitlement rule's plan/add-on targets must name at least one
   target (the schema rejects an empty list), and absence of a granting rule denies.
   Leave a filter empty only when "everyone" is the intent, and say so in your notes.
   Author segments before the rules that reference them.
6. **Unlimited is the literal `"unlimited"`** on limit and allowance fields — the UI
   renders it as "Unlimited." Seats are the exception: unlimited is `null`, and `999999`
   exists only as an export sentinel that maps back to null — never author it.
7. **Credits carry their natural unit** ("minutes", "tokens", "videos") — never a generic
   "credits" default. Convert annual allowances to monthly with rollover up to the annual
   cap.
8. **Unit casing follows the pricing page**: acronyms upper ("GB", "API", "SMS"), words
   lowercase plural ("messages", "minutes").
9. **Every placement needs a trigger, and every payload content.** The trigger says when
   (usage threshold, entitlement gate, trial event, surface render); the payload says what
   shows where; a CTA path says what happens next. Most payloads need one — a few
   templates (toast, tooltip, CLI) legitimately have none, but a payload with nothing to
   click rarely earns its place. Use the CTA and trigger options `revturbine schema`
   emits — never invent values — and author only CTA path types the app already handles,
   or put the missing handler on the wiring list. Only the payload's first CTA carries an
   actionable path.
10. **Non-public tiers route to sales.** Any tier a user can't self-serve into gets
    `contact_sales` / `book_demo` CTAs — never `open_checkout`. Reserve checkout for
    public, self-serve tiers; don't drive upgrades into phased-out (legacy) tiers at all.
11. **Prices: Stripe is the source of truth.** Where the schema carries price fields or
    Stripe references, they map to real Stripe prices — `revturbine-connect-billing` owns
    that mapping. Use clearly-marked placeholders until it runs; never fabricate IDs or
    amounts.
12. **Evidence per number, and no silent gap-filling.** Every price and limit carries a
    source (URL or "confirmed by <name>") in your notes; flag inferred values. Where a
    number has no source, never quietly supply one — say so, and give your human the
    choice between a **designed proposal** (your reasoning, labelled as a proposal) and an
    **obvious placeholder** to replace later. Either way it goes on the corrections list.
    Designing pricing on request is legitimate; passing a guess off as a fact is not.
13. **Additive edits to live Playbooks.** Start from the downloaded live Playbook and
    change it. Before staging, read the `diff` specifically for **removals**: upload is
    convergent, so an entity missing from your file is a real deletion. A guard blocks
    emptying or mass-deleting a populated type; `--prune` confirms a deletion
    deliberately, `--no-prune` imports additively. Read the diff by which entities appear
    on each side, not by trusting the labels — the CLI's file-vs-`--live` direction is
    currently inverted (ledger F-22).
14. **Handles are a published contract.** Once app code, tests, or a live Release
    reference a handle, renaming it is a breaking change, not a tidy-up: the old handle
    stops resolving and gates fail closed. Add the new object and migrate call sites
    deliberately; never rename in place to fix casing or wording.
15. **Coherence, not just validity.** A Playbook can be schema-valid and still say nothing
    useful. Before you hand it over, check that every entitlement has at least one
    granting rule, every placement's entitlement handle exists, and every tier is
    reachable by some CTA. Orphans here are invisible in JSON and obvious when you render
    each type as a list.
16. **Trials are RevTurbine's** (classic or reverse, per-plan lengths) — don't model them
    as billing-provider trials.
