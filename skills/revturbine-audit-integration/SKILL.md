---
name: revturbine-audit-integration
description: >
  Review a built RevTurbine integration for anti-patterns and for how its
  offer screens look. Two passes, both read-only. The rules pass scans the
  app code and the Playbook for workarounds that rebuild what the SDK
  already provides: code that reads the Playbook file, a hand-built
  dialog, untagged checkout, re-implemented entitlement rules, stale
  versions, leftover validator warnings. The screen pass captures every
  offer screen per plan, compares it with the app before the change,
  judges it against a short standard and walks each journey with repeat
  clicks. Produces a findings list with evidence, severity and the fix.
  Use when someone says "review the integration", "find anti-patterns",
  "find workarounds", "review the offer screens", "is this built the
  intended way", "review this branch before the demo", or when an agent
  reports its integration finished. Skip if a single decision misbehaves
  or names do not match (revturbine-verify-integration), or if making a
  known change (revturbine-wire-monetization-surfaces,
  revturbine-author-playbook, revturbine-connect-billing). Load
  revturbine-start-here first if this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.1.0"
  safety_class: read-only-inspection
  schema_version: ">=0.1.0 <0.2.0"
  tier: free
---

# RevTurbine — Audit Integration

You are reviewing an integration somebody else built, often another
agent. **You change nothing here.** You produce findings; each fix routes
to the skill that owns it.

This skill asks two questions that `revturbine-verify-integration` does
not. That skill asks whether the names agree and the decisions come out
right. This one asks:

1. **Is it built the intended way?** An integration can pass every check
   and still be a second copy of the SDK written in app code. Each copy is
   a place where the app and the Playbook can drift apart, and where a
   Playbook change stops reaching users without a deploy.
2. **Is each offer screen good?** A script can prove the right offer
   shows for the right plan. It cannot tell you the dialog fills the
   window, leads with the wrong button, or is worse than what the app had
   before.

Run both passes. An audit that reads the screens and never looks at them
misses the problems a user meets first.

The detail lives in two reference files beside this skill. Read each
before you start its pass:

- `references/rules-pass.md` — sixteen anti-patterns, each with how to
  detect it, why it matters, and the intended pattern.
- `references/screen-pass.md` — the six steps, the standard for a good
  offer screen, and the journeys to walk.

## Before you start

- **Say what you are auditing**: the branch and commit, the Playbook file
  the provider loads (follow the import into `localRuntime: { playbook }`),
  and the installed SDK and CLI versions (`revturbine --version` from the
  app directory).
- **Find the intent, outside the branch.** Ask your human for the plan the
  integration was built to: the growth or monetization plan, any standing
  decisions ("a blocked click always shows an offer", "discounted packs
  come first"), and the screens as they are in production today. The
  branch's own notes and tests describe what was built. They are not the
  standard. A test that asserts "this plan gets no offer" records a gap as
  a pass.
- **Inventory the SDK surface the app uses.** List every import from
  `@revturbine/sdk` and `@revturbine/sdk/headless` and every call on the
  SDK instance. Then list what it does not use. An app that imports only
  the provider and the headless placement controller, and none of
  `<Gate>`, `<Slot>`, the hooks, checkout tagging or the plan and add-on
  lookups, has told you where to look.
- **Measure the integration layer.** Count the lines of app code that
  exist only to talk to RevTurbine. A thin integration is a provider
  mount, gates, slots, a resolver map and reporting. Thousands of lines
  mean something was rebuilt.

## Pass 1 — the rules pass

Work through `references/rules-pass.md` in order. In brief:

| # | Anti-pattern | First place to look |
|---|---|---|
| R1 | App code reads the Playbook file for buttons, packs, prices or plans | Imports of the Playbook JSON outside the provider mount |
| R2 | The headless controller paired with the app's own dialog | `PlacementController` or `EntitlementGate` in a React app |
| R3 | A slot is asked that no placement names as its trigger | The slot inventory diagnostic; the Playbook's triggers |
| R4 | An offer is accepted in a slot its payload does not list | Payload slot lists against the slots the app asks |
| R5 | Frequency limits on an offer that answers a blocked click | Caps on payloads requested from click handlers |
| R6 | A blocked action can end on a bare error | The branch where the check denies and nothing shows |
| R7 | Checkout starts without the offer tag; finished purchases are not reported | Every place a checkout session is created |
| R8 | Custom actions on the generic `custom` path, filtered by an app allowlist | `"path": "custom"` in the Playbook |
| R9 | Entitlement rules re-implemented in app or server code | Limits, grace amounts and plan comparisons in code |
| R10 | The app works out the user's plan itself | Price-to-plan maps and subscription listeners |
| R11 | The app fills wording tokens the Playbook does not know | String replacement on placement copy |
| R12 | SDK or CLI behind the latest release | `revturbine --version` |
| R13 | Validator warnings left in place | `revturbine validate` on the loaded Playbook |
| R14 | A workaround for a missing SDK capability, with no report | Comments and guards that say why the SDK was bypassed |
| R15 | The bundled Playbook differs from the launched Release | `revturbine diff` against the live Release |
| R16 | An offer reused at a moment it was not written for | One slot id requested from unrelated screens |

Three rules for this pass:

- **Evidence is a file and a symbol**, plus the search or probe that
  found it. "The app seems to" is not a finding.
- **Classify the cause** of each finding, because it decides the fix:
  *integration choice* (the SDK supports it and the app did not use it),
  *SDK gap* (the SDK cannot do it yet), or *docs gap* (what is written
  does not match what ships).
- **Never recommend a bigger workaround.** Where the SDK cannot yet do
  the intended thing, the finding is "report it to RevTurbine", with the
  smallest safe stopgap named as a stopgap. The reference file marks
  those cases.

## Pass 2 — the screen pass

Work through `references/screen-pass.md`. The six steps:

1. **Baseline first.** Open the app as it is today, before the
   integration, and capture every screen an offer will touch.
2. **Look, do not read.** Capture each offer screen for each plan at a
   laptop window size, and look at the picture.
3. **Judge against the short standard.** The screen says why the user is
   seeing it. One best offer comes first. Each offer has its own button
   and price. There is one way to close. It fits the window. Nothing is
   worse than the baseline.
4. **Walk the journeys.** For each plan, go from the trigger to the
   purchase and back, more than once: repeat the click, and cross from
   one slot to another.
5. **Show the pictures.** Put each screenshot in the findings with the
   verdict beside it, so a reader can disagree.
6. **Check the intent.** Compare each screen with the plan and the
   standing decisions you collected, not with the branch's notes.

If you cannot run the app or cannot take screenshots, say so at the top of
the report and mark the screen pass **not done**. Do not substitute a
reading of the component code and call it a screen pass.

## Report

One findings list, ranked by what an end user or the business loses:

1. Screens that would embarrass a demo or block a purchase.
2. Bugs a user can reach: the wrong offer, a dead end.
3. Revenue that cannot be measured or is left on the table.
4. App code doing the SDK's work.
5. Hygiene: versions, warnings, drift.

For each finding give:

- **What a user sees**, in one or two plain sentences.
- **Evidence**: file and symbol, the search or probe output, and the
  screenshot for a screen finding.
- **Severity**: *blocking* (a user is harmed or a purchase is lost
  today), *high* (it breaks when the Playbook changes or goes hosted),
  *medium* (duplicate code that will drift), *low* (hygiene).
- **Cause**: integration choice, SDK gap, or docs gap.
- **The fix and its owner**: Playbook content is
  `revturbine-author-playbook`; gates, slots and CTA handlers are
  `revturbine-wire-monetization-surfaces`; checkout and Stripe are
  `revturbine-connect-billing`; provider mount and identity are
  `revturbine-integrate-sdk`; anything marked SDK gap or docs gap is a
  report to RevTurbine.

Close the report with three short lists: what you tested and how, what
you could **not** check, and every SDK gap or docs gap to report. Say
plainly which findings you proved and which you inferred.

## Report gaps, do not absorb them

A missing SDK capability that is worked around in silence stays missing
for everyone. For each SDK gap or docs gap, draft a report your human can
send: what the app needed, the SDK and CLI versions, the workaround that
exists today (file and symbol), and the smallest reproduction. Never
include tokens or secrets. `revturbine-start-here` → If you get stuck has
the route.

## Versions

Written against `@revturbine/sdk` 0.18.0 and the CLI at 0.21.22. Each
entry in the rules reference names the SDK version an API needs. Before
you recommend an API, confirm it exists in the installed package's own
type declarations; where the installed version is older, the finding is
the upgrade (R12) first.

## If you get stuck

Command syntax comes from `revturbine <command> --help`, never from
memory. For anything else, follow `revturbine-start-here` → If you get
stuck.
