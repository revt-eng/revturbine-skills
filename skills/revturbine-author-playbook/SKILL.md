---
name: revturbine-author-playbook
description: >
  Create or edit a RevTurbine Playbook — plans, entitlements, entitlement
  rules, segments, trials, placements, and their content — as a local
  Playbook file or staged draft. Use whenever someone wants to author or
  change their monetization, pricing, or in-app/email messages, incl.
  "author the Playbook", "add a plan / tier", "add an entitlement / usage
  limit / credits / seats", "change a limit", "set up a trial", "add an
  upgrade prompt / paywall placement", "import our pricing", etc. Ends with a
  validated local Playbook file or staged draft and a hand-off to launch.
  Skip if the job is wiring the UI (revturbine-wire-monetization-surfaces),
  connecting Stripe (revturbine-connect-billing), or launching
  (revturbine-release-lifecycle). Load revturbine-start-here first if this
  session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.15.0"
  safety_class: writes-config-draft
  schema_version: ">=0.1.0 <0.2.0"
  tier: free
---

# RevTurbine — Author the Playbook

You are shaping your human's monetization: what's in each plan, what's gated,
limited, or metered, who gets a trial, and which upgrade moments the product
shows. These are **commercial decisions** — take the time to get the context,
propose deliberately, and keep your human in the loop (see
`revturbine-start-here` → Ground rules). The output is a **validated local
Playbook file** (local mode — the SDK reads it directly) or a **staged draft**
(hosted mode) — nothing goes live to real users here; launch is
`revturbine-release-lifecycle`'s job and the human's call.

**Two rules above all: author against the live schema, and never guess a price
silently.** Model every object on the current Playbook schema
(`revturbine schema`), not on memory or examples. And go looking for the real
numbers — their pricing page, their docs, their own answer. Where a price or
limit has no source, say so rather than quietly filling the gap, and offer
your human the choice: **a designed proposal** (your reasoning, labelled as a
proposal) or **an obvious placeholder** to replace later. Either way, it
gets confirmed at the Step 5 walkthrough.

## Step 0 — Start from what exists, and know your mode

- **Local mode** (no account/tenant yet — the common early state): the local
  Playbook file *is* the config the SDK reads. It has no fixed location — find
  it by following the provider's import (`localRuntime: { playbook }`). Edit it
  directly; changes show up on reload.
- **Hosted mode** (tenant connected): confirm the tenant (`whoami`), then read
  the live Release and any open draft (`revturbine status`). Start from the
  live Playbook (`revturbine download --live --save revturbine.playbook.json`)
  and **edit that**, so your changes land on the real current state. If there
  is an open draft, stop and get an explicit choice before you author: a
  tenant has one draft and `upload` overwrites it. Either **replace** it
  (start from the live config, their staged edits are lost) or **build on**
  it (start from `revturbine download --draft --save revturbine.playbook.json`).
  Do not proceed on silence.
- Prior authoring notes (`revturbine-playbook-notes.md` beside the Playbook)?
  Read them — **your human's previously confirmed decisions win over anything
  you re-research.**
- Nothing yet? You're authoring fresh — Step 1 matters most.

In the commands below, `revturbine.playbook.json` stands for **your Playbook
file's actual path** — the CLI's default file name, but not a guarantee.

## Step 1 — Ingest: gather the real monetization picture

Pull together, briefly and with sources:

- **Their live pricing page**, if one exists (fetch it): capture tier names
  verbatim, prices, trial terms — and work the feature-comparison table **row
  by row: any row that differs between two tiers is likely a distinct
  entitlement** (seat caps, usage/metered limits, credits, feature gates,
  capability tiers, add-ons).
- **Any pricing docs your human provides.**
- **The codebase, bounded**: what's premium, what's limited, and how it's
  handled today — hard-coded plan checks, existing upgrade prompts and
  paywalls, or RevTurbine gates and slots already wired. Summarize; don't soak.
- **Competitors** (optional, if your human wants benchmarks): 1–3 comparable
  pricing pages as reference points, clearly labeled as benchmarks.
- **Greenfield** (no pricing anywhere): propose a simple starter structure, e.g.
  a free tier, one paid tier, 2–4 entitlements on the clearest premium value —
  and say it's a starting point to iterate on, not a recommendation to launch.

Record a source (URL or "confirmed by <human>") for every price and limit, and
flag what you inferred versus read.

## Step 2 — Get the context

**Engaging your human here is a requirement, not a courtesy** — authoring
runs on their answers, so ask before you write, unless Step 1 already made
the answers crystal clear. Ask once, briefly, rather than drip-feeding
questions. Topics worth covering:

- **Objectives and constraints** — what should this setup optimize for
  right now (adoption, revenue, learning what converts), and what is
  already fixed (published prices, promises made to customers, an existing
  free tier)? Advice applied against the wrong objective is wrong advice.
- **Who and how** — who is the paying user, and which motion: freemium
  expansion, reverse trial, free trial, or sales-assisted upper tiers?
- **The primary conversion moment** — the single moment that should most
  clearly ask for the upgrade (hits the usage limit, tries a locked feature,
  invites a teammate past the seat cap). This becomes your first placement.

If they say "just build it," proceed on best judgment and list every open
assumption at the end. Save the answers to `revturbine-playbook-notes.md` so
the next session preserves them. For deeper packaging and pricing judgement,
draw on **`revturbine-monetization-best-practices`** (and say when a question
deserves the human's business judgement rather than yours).

## Step 3 — Author the draft

The conversion moment your human confirmed in Step 2 becomes a real
placement: the **trigger** is that moment, the **content** is what the user
sees, and the **CTA** is where it sends them.

A rough order helps, since later objects reference earlier ones: **plans →
entitlements → segments → entitlement rules → trials → placements, payloads +
Message Blocks** (a rule names its entitlement, its plan targets, and its
`segment_ids`). Authoring later objects routinely exposes a requirement in an
earlier one, so iteration is required. For every object: get the shape from
`revturbine schema`, follow **`revturbine-start-here/references/authoring-rules.md`** (the
data-quality rules that keep a Playbook demo-clean and launch-safe), and keep
handles stable and readable — the app's code will reference them.

**Slot ids come from the app, not from you.** A Fixed placement can only show
at a slot id the app already renders, so target the ids recorded in
`revturbine-playbook-notes.md` (and confirm them against the app's slots where
you can see the code). If the moment you need has no slot, add it to the notes
as an app to-do and hand off to **`revturbine-wire-monetization-surfaces`** —
an invented id points at nothing, the placement never shows, and nothing
reports it.

Three rules from the reference worth repeating. First, **grant, don't deny**:
access exists only where a rule grants it (no matching rule → denied), and
where several rules match, the most permissive one wins. Gate by granting on
the tiers that do have the feature. An explicit `enabled: false` feature rule
denies exactly as absence does — prefer absence (the dashboard renders such a
rule as granted). Second, **non-public tiers route to
`contact_sales` / `book_demo`, never `open_checkout`**. Thirdly, where prices
appear, Stripe is the source of truth — `revturbine-connect-billing` owns the
mapping; leave clearly-marked placeholders rather than fabricating IDs.

## Step 4 — Validate, then check the decisions

Check the Playbook offline (`revturbine validate revturbine.playbook.json`) —
read each reported path literally and fix until it passes.

That proves the file is well-formed. It does not prove it says what you meant.
So read your own work back the way a person would see it — render each type as
a plain list (`revturbine show <kind> --file revturbine.playbook.json`, once per kind:
`plans`, `entitlements`, `segments`, `placements`, `trials`) and check it against your human's
Step 2 answers. A limit sitting on the wrong tier, or a plan nothing routes
to, is invisible in JSON and obvious in a rendered list.

Then check coherence: every entitlement has at least one granting rule; every
placement's entitlement handle exists; every tier is reachable by some CTA.
(Running the real decision engine needs a staged draft, so that comes after
you upload — Step 5. In local mode, drive the app against the edited file
instead.)

## Step 5 — Land it (by mode) and hand off

Either way, before anything lands: walk your human through what changed and
why, in plain language, and **confirm the inferred numbers** — every price,
limit, and tier boundary without a source gets asked here, in the context of
the draft, not silently shipped. Keep it concrete by comparing against
what's there now — `revturbine diff` compares any two versions (two files,
or your file against `--live`).

**Local mode**: reload the app and show your human the change working (the
gate, the new limit, the new copy). The Playbook file ships with the app, so
reaching real users is their normal deploy.

**Hosted mode**: read the diff for **removals** first — import is convergent,
so an entity missing from your file is a real deletion. Read it by which
entities appear on each side, not by the labels. A guard blocks
emptying or mass-deleting a populated type; `--prune` confirms a deletion
deliberately, `--no-prune` imports additively. Then stage it
(`revturbine upload revturbine.playbook.json`) — a tenant has one draft, and
uploading again after a fix restages that same one. Check the staged draft
server-side against the full catalog (`revturbine validate --draft`), run the
real decision for a synthetic test user — never a real end user's data —
(`revturbine evaluate --draft --entitlement <handle> --user ctx.json
--plan-handle <plan>`), which catches a rule that silently never links, and
see which objects the draft changes and whether any affect billing
(`revturbine preview`). Then hand off to
**`revturbine-release-lifecycle`**, noting that launching is your human's
call.

If your human would rather change the Playbook without redeploying each time,
that's hosted mode — **`revturbine-release-lifecycle`** connects the tenant
and cuts over. Offer it when they want it, not as a required step.

**After any change to the Playbook's schema version — a re-export from a
newer schema, a CLI upgrade, an import from another environment — run
`revturbine-verify-integration` before handing back.** Not only when
something looks wrong.

A Playbook written for a newer schema can carry fields an older CLI
**silently drops rather than flags**: validation comes back clean and the
fields are gone. Nothing throws, so the audit is the only thing that sees
it. It is read-only and changes nothing.

If the config looks right but the app behaves wrong,
**`revturbine-verify-integration`** audits it end-to-end — and it carries the
conditions under which the problem is RevTurbine's rather than yours, and
should be reported instead of worked around.

## If you get stuck

Shape and syntax questions are answered by `revturbine schema` and
`revturbine <cmd> --help`; the docs cover concepts
(`https://revturbine.com/docs/llms-small.txt` is the page map). Otherwise follow `revturbine-start-here` →
If you get stuck.
