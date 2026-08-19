---
name: revturbine-release-lifecycle
description: >
  Take an authored RevTurbine Playbook live, and manage what is live —
  review a staged draft (validate, preview, diff), launch it as a versioned
  Release, restore a prior Release, and move a local-mode integration to
  hosted mode (connect the tenant, first launch, provider swap). Use when
  someone says "launch", "go live", "ship it", "release this", "roll back",
  "restore", "undo that launch", "connect the tenant", or "move off local
  mode". Launching is always the human's call — this skill prepares,
  verifies, and hands over. Skip if the job is authoring the Playbook
  (revturbine-author-playbook), wiring the UI
  (revturbine-wire-monetization-surfaces), or connecting Stripe
  (revturbine-connect-billing). Load revturbine-start-here first if this
  session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.4.1"
  safety_class: launches-live
  schema_version: ">=0.1.0 <0.2.0"
  sdk: "^0.2.77"
  tier: free
---

# RevTurbine — Release Lifecycle

You own the moment a Playbook goes live in front of real users. Everything
before this skill is reversible — a file, a staged draft. Everything here
is a **Release**: a versioned, immutable snapshot serving your human's
product, where a wrong limit or price affects real users and real billing.
This is the strictest safety class in the catalog (`launches-live`), and
one fact shapes all of it: **the launch command has no confirmation prompt
of its own — the only gate is your human's explicit go-ahead, gathered by
you before you run it.**

Releases are append-only: every launch cuts a new version, any prior version
can be restored, and a restore is itself a new Release. That recovers config
state — not the real-world effects (charges, messages) of the time it was
live.

## Know which door you came in

In the order the sections below cover them:

- **The app runs on a local Playbook file and your human wants to go
  live** → Move from local to hosted mode, then continue into the review
  section for the first launch.
- **A draft is staged and ready** (usually `revturbine-author-playbook`
  handed you here) → Review the draft, then launch.
- **Something live is wrong and needs to come back down** → Restore a
  prior Release.

Before anything that touches the server, confirm which tenant you are
acting on (`revturbine whoami`) — the tenant is bound to the token, and
you never silently default it.

## Move from local to hosted mode

Local mode can be used to rapidly prove the integration; hosted mode is
the product promise — the Playbook changeable from the dashboard or CLI
without redeploying. The move is four steps, in this order, so hosted
mode has a Playbook to serve before the app depends on it.

1. **Connect the tenant.** Your human needs an account — created at
   revturbine.com/app/signup or from the terminal (`revturbine signup`);
   creating one is theirs to do, not yours. Then authenticate
   (`revturbine login`, a browser device flow they approve) and confirm
   the resolved tenant (`revturbine whoami`).
2. **Stage the local Playbook as the launch candidate.** Do not hand-recreate
   it. The Playbook that matters is the one the app actually loads — find
   it by following the provider's import (`localRuntime: { playbook }`);
   a Playbook file saved anywhere else is not the one running. Check it
   offline (`revturbine validate <file>`) and stage it
   (`revturbine upload <file>`). Then run the review section below — the
   first launch is a launch like any other, and it is your human's call.
3. **Swap the provider to hosted.** This is an edit to the app's own code
   — the options passed to the RevTurbine provider — so **invoke
   `revturbine-integrate-sdk`**, which owns provider setup and runtime
   mode; you orchestrate the cutover, it makes the change. Tell it to
   drop the local-runtime options and connect the tenant instead. The
   components themselves do not change.
4. **Turn on analytics.** Event ingestion needs a public ingest key —
   mint one scoped to the app's origin
   (`revturbine ingest-keys create --origin <app-origin>`). **The key
   is shown once and cannot be retrieved again** — have your human store
   it immediately, then set it as the provider's `ingestPublicKey`.
   Without it, gating works but the dashboard shows no funnels or
   placement analytics — most of hosted mode's payoff.

Then prove the move held: the gate that worked locally behaves the same
in hosted mode, and the app still renders its baseline UI when
RevTurbine is unreachable or a placement resolves to nothing — hosted
mode added a network dependency, and it must never take the product down.
Then offer this demonstration: change one thing in the Playbook, take it
through the review section to launch (their call), and reload — the app
changes with no code deploy.

## Review the draft, then launch

Work through these in order. Each step can send you back a step; none of
them is skippable. A
first production launch also requires a clean end-to-end audit
(`revturbine-verify-integration`) — run it, or record that your human
waived it, before step 5.

1. **Read the current state** — the live Release and the open draft, side
   by side (`revturbine status`). If the draft isn't the one you expect,
   stop and sort that out first: a tenant has one open draft, and
   uploading overwrites what it held.
2. **Run the authoritative check** — the full server catalog against the
   staged draft (`revturbine validate --draft`). Offline validation was a
   fast first pass; this is the check that gates launch. Fix every
   blocking finding at its reported path and re-stage. Structural findings
   (`error_draft`) always block. Launch-gate findings (`error_launch`) mean
   the Playbook is valid but incomplete — a Message Block missing copy for
   one value of the dimension it varies by, for example. Fix them.
   `--force` on `revturbine launch` bypasses the `error_launch` tier only —
   `error_draft` still blocks — and exists for deliberately incomplete
   launches on a test tenant. Do not use it unless your human
   explicitly tells you to, and name what it skips when you relay that
   choice.
3. **See what the launch changes** — the objects affected and whether any
   of them touch billing (`revturbine preview`), and the comparison
   against what is live (`revturbine diff --draft --live`). **Read the
   diff for removals first**: import is convergent, so an entity missing
   from the uploaded file is a real deletion, and launching makes it
   real for every user.
4. **Walk your human through it** in plain language: what changes, who
   sees it, what it costs, anything removed. Keep it short and concrete —
   this is the decision briefing, not a changelog dump.
5. **Launch with consent.** Get consent from your human: *"The draft is
   staged and validated. Launching puts this live for real users, so I
   need your explicit go-ahead — reply 'launch' or run it yourself."* Do
   not launch until they answer. Then take it live
   (`revturbine launch --draft`).
6. **End with proof.** The new version is live (`revturbine status`), and
   a spot-check decision comes back as intended — run the real engine for
   a representative user against the live config
   (`revturbine evaluate --live --user <ctx.json> --entitlement <handle>`).
   If the server refuses the launch with a conflict — the live Release
   moved after the draft was staged — start again from the current live
   Playbook (`revturbine download --live`) rather than retrying blind.
   If a launch step fails partway, the draft is staged but **not** live —
   say so plainly, and finish or fix rather than assuming either state.

## Restore a prior Release

When something live is wrong, restoring is the fast, safe path — not
hand-editing a fix under pressure.

- **Find the target** in the Release log (`revturbine history`), and show
  your human what they would be going back to — its summary views
  (`revturbine show plans --release <id>`) or its differences from live
  (`revturbine diff --release <id> --live`).
- **Stage the restore with their go-ahead** (`revturbine restore <id>`),
  which builds a new draft from that Release's frozen snapshot. Restoring
  needs your human's approval like launching does, even though this step
  only stages a draft. It halts if a draft is already open — that draft
  is in-progress work; confirm with your human before discarding it
  (`revturbine discard --yes`).
- **Launching the restore is a launch.** The same review and the same
  consent sentence apply; nothing about urgency waives them. Once your
  human has said go, take it live (`revturbine launch --draft`). `restore <id> --launch`
  combines staging and launch in one command — use it only after this review
  has already run and your human has approved.
- A restore rolls **forward**: it cuts a new Release that reproduces the
  old one. History stays append-only, so the misstep and the recovery are
  both on the record.

## If you get stuck

Command syntax comes from `revturbine <command> --help`, never from
memory. For anything else, follow `revturbine-start-here` → If you get
stuck.
