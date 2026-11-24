# The rules pass — sixteen anti-patterns

*Reference for `revturbine-audit-integration`. Each entry says how to
detect the pattern, why it matters, and what the intended pattern is.
Verified against `@revturbine/sdk` 0.18.0 and the CLI at 0.21.22; each
entry names the SDK version an API needs. Confirm every API in the
installed package's own type declarations before you recommend it.*

**Conventions.** Search commands use `rg` (ripgrep) and `jq`; substitute
your own tools. `$PLAYBOOK` is the file the provider loads. Exclude
`node_modules`, build output and tests from code searches unless the
entry says otherwise. Field names in the `jq` examples are the canonical
Playbook's; confirm them with `revturbine schema` if a query returns
nothing. A search that returns nothing is evidence only when you have
shown the search can match: run it once against a line you know is
there.

**Default severity** is a starting point. Raise it when a user can reach
the failure today; lower it when the code path is dead.

**Cause** is one of *integration choice*, *SDK gap* or *docs gap*. Where
an entry says **SDK gap**, the fix is a report to RevTurbine, and any
stopgap is named as one.

---

## R1. App code reads the Playbook file for buttons, packs, prices or plans

**Detect.**

```bash
rg -n "playbook(\.json)?['\"]" --glob '!**/node_modules/**' src
rg -n "placement_payloads|placements\[|plan_variations|addon_variations|stripe_price_id|content_ui_paths" src
```

One import is legitimate: the module that passes the file to the provider
(`localRuntime: { playbook }`). Every other reader is a finding. Typical
shapes: a helper that looks up a payload by its output id to read its
buttons; a module that walks plan or add-on variations for prices or
Stripe price ids; a function that checks whether the Playbook defines a
slot before asking for it.

**Why it matters.** The decision and the file can be two different
versions. In local mode they happen to be the same file, so it works. In
hosted mode the SDK decides from the launched Release while the app
still reads the copy in the repo: an offer and its buttons then come from
two versions, with no error. The reader also breaks silently when the
Playbook's shape changes, because nothing type-checks raw JSON.

**Intended pattern.** Ask the SDK.

- **Buttons**: the decision's ordered `ctas` list on its output, each
  with a label, a resolved path, a role and an emphasis. Up to five from
  SDK 0.18.0. Earlier versions return one button and one extra label; if
  the app reads the file to get a third button, the fix is the upgrade
  (R12), then delete the reader. The validator warns when an offer has
  more buttons than a decision carries.
- **Plans and packs with prices**: `getEligiblePlans()` and
  `getEligibleAddons()` on the SDK instance, or the `usePlans()` and
  `useAddons()` hooks in React. These are in the published type
  declarations; the public guides do not cover them yet, so read the
  signatures in the installed package.
- **Which Playbook is loaded**: `getExportedConfig()`, for diagnostics
  only, never to drive what a user sees.

Fix owner: `revturbine-wire-monetization-surfaces`. Default severity:
high. Cause: integration choice, unless the SDK cannot return what the
app reads; then SDK gap.

## R2. The headless controller paired with the app's own dialog

**Detect.**

```bash
rg -n "PlacementController|EntitlementGate|session\.placement\(|session\.entitlement\(" src
rg -n "<Gate\b|<Slot\b|usePlacement\(|useGatedAction\(|useCan\(|useEntitlement\(" src
```

A React app with hits on the first line and none on the second is the
pattern. Then find what draws the offer: an app modal or card that takes
a decision as a prop. Also look for a module-level bridge that lets app
code reach an SDK instance mounted in a separate subtree. That is the
sign the provider does not wrap the screens that need it.

**Why it matters.** The SDK's components handle what the hand-built layer
has to get right by hand: which payload answers a gate, impression and
dismissal reporting, button roles, the rule that a gate never shows a
dismiss button, and theming from the Playbook's branding. Every bug class
in a hand-built layer (wrong offer in a slot, a limit consumed by the
wrong screen, an unreported render) is one the components do not have.

**Intended pattern.**

- **A feature or a region of UI**: wrap it in `<Gate id can>`. Denied
  users get the gate placement in place of the children, or the
  `deniedFallback` you supply. Guide:
  https://revturbine.com/docs/guides/entitlements/
- **A click on an action**: `useGatedAction` in React or `gate(action,
  fn)` on the SDK instance runs the function only when entitled. On
  denial they render nothing; the result reports that the function did
  not run and carries the entitlement result, and the app then shows the
  gate placement for that entitlement. See
  https://revturbine.com/docs/getting-started/api-overview/
- **A place where a prompt appears**: `<Slot id>` or `usePlacement()`.
  Guide: https://revturbine.com/docs/guides/placements/
- **The app's own look**: register a custom slot type through
  `PlacementTypeRegistry` so the SDK still owns the decision, the
  reporting and the buttons. Guide:
  https://revturbine.com/docs/guides/custom-slots/
- **Headless is for code with no React**: a server, a worker, another UI
  framework. Guide: https://revturbine.com/docs/guides/headless-api/ .
  A headless caller owns the reporting the components do for it. Check
  that it reports the render, the click and the dismissal through the
  controller.

**SDK gap to report, not to build around.** As of 0.18.0 there is no
single call that checks an entitlement at a click, shows the offer, and
resolves with the user's choice. If the app built a "check, show, wait
for the answer" layer for that, the finding is: use `useGatedAction` and
a `<Gate>` or `<Slot>` for the display where the provider can wrap the
screen, and report the missing one-call form. Do not recommend a larger
abstraction.

**If the provider cannot wrap the app** because it has signed-out
visitors: a user is required, and there is no anonymous mode. From SDK
0.16.0 the `user` option may be a promise that resolves at sign-in. While
it is pending the SDK is off and a `<Gate>` renders nothing, and when it
resolves nothing remounts. Check whether that lets the provider sit at
the root. Guide: https://revturbine.com/docs/guides/identity-lifecycle/ .
If the app needs offers for visitors who never sign in, that is an SDK
gap: report it.

Fix owner: `revturbine-wire-monetization-surfaces` (and
`revturbine-integrate-sdk` for the mount). Default severity: high.
Cause: integration choice, sometimes forced by an SDK gap or docs gap;
say which.

## R3. A slot is asked that no placement names as its trigger

**Detect.** List the slot ids the app asks for:

```bash
rg -n "<Slot[^>]*\bid=|surfaceSlot:\s*\{|usePlacement\(\{" -A3 src
```

List the slots that placements trigger on, and the declared slots none
triggers on:

```bash
jq -r '[.placements[].trigger? | select(.type=="surface_render") | .slot_id] | unique | .[]' "$PLAYBOOK"
jq -r '([.placements[].trigger? | select(.type=="surface_render") | .slot_id] | unique) as $t
       | .placement_slots[].id | select(. as $s | $t | index($s) | not)' "$PLAYBOOK"
```

Or ask the running app, after the screens that request slots have
rendered:

```ts
const d = sdk.diagnoseSlotInventory();
console.log(d.configAvailable, d.mountedButUnauthored, d.authoredButUnmounted);
```

`mountedButUnauthored` is this finding. A slot id that appears only in a
gate placement's entitlement trigger is not a finding; that slot is
answered through the gate.

**Why it matters.** When a placement's trigger names the requested slot,
only that placement's payloads are considered. When none does, the SDK
considers every payload whose template and plan match. The slot then
shows whatever ranks first, and when that offer reaches a frequency limit
the next one takes its place, which can be an offer written for a
different moment entirely, such as a cancellation offer on a Generate
click.

**Intended pattern.** Every slot id the app asks for is named by a
placement's trigger, or the moment is an entitlement check answered by a
gate (R5). One placement serving three screens means three placements,
or one gate, not one trigger and two unnamed slots.

Fix owner: `revturbine-author-playbook`. Default severity: blocking when
a capped offer can be requested there; otherwise high. Cause: integration
choice.

## R4. An offer is accepted in a slot its payload does not list

**Detect.** Find payloads whose slot list goes beyond the slot their
placement triggers on:

```bash
jq -r '.placements[] | (.trigger.slot_id // null) as $t | .payloads[]?
       | select((.surface_slot_ids // []) | length > 0) | select($t != null)
       | select((.surface_slot_ids - [$t]) | length > 0)
       | "\(.id): lists \(.surface_slot_ids | join(",")); trigger fires on \($t)"' "$PLAYBOOK"
```

Then, for each slot the app asks, request a decision as each plan and
compare the winning output's payload with the slot. Drive the app, or in
hosted mode run `revturbine evaluate` with `--slot`. A winner whose
slot list does not include the slot that was asked is the finding.
Repeat with any capped offer exhausted (see the screen pass, repeat
clicks).

**Why it matters.** A payload's slot list reads as "this offer shows
here and nowhere else". **As of SDK 0.18.0 the SDK does not filter
candidates by that list.** Only the placement's trigger slot narrows
them. So the list documents intent without enforcing it, and R3 slots
receive offers that were never written for them.

**Intended pattern.** Do not rely on the payload's slot list to keep an
offer out of a slot. Make each slot's placement name it as the trigger
(R3). If the app carries its own guard that compares the winning payload
with the requested slot, record it as a stopgap for an **SDK gap** and
report the gap; do not ask for the guard to be removed until the SDK
enforces the list.

Fix owner: `revturbine-author-playbook`, plus a report. Default severity:
blocking when reproduced on screen. Cause: SDK gap.

## R5. Frequency limits on an offer that answers a blocked click

**Detect.** List payloads with a cap or a cooldown, with their
placement's category:

```bash
jq -r '.placements[] | .category as $c | .id as $p | .payloads[]? | select(.caps != null)
       | select((.caps.max_per_period != null) or ((.caps.cooldown_days // 0) > 0))
       | "\($p) [\($c)] \(.id): \(.caps | tojson)"' "$PLAYBOOK"
```

For each, find where the app asks for its slot. If the request sits in a
click handler on the path where an action was refused (out of credits,
over a limit, feature locked), it is the finding.

**Why it matters.** The user clicked and was refused. An offer that
answers that click is the way forward, and it has to be there every
time. With a limit of five a day, the sixth refusal shows a different
offer or nothing. The limit also spends itself in the wrong place: a
once-per-session offer shown at an unrelated click is gone when the
moment it was written for arrives.

**Intended pattern.** A blocked action is an **access gate**: a
placement in the gated category whose trigger is the entitlement, shown
through `<Gate>` or after `useGatedAction` reports a denial. Gates have
no caps and no cooldowns; the SDK ignores them on a gate and the
validator warns. For a metered action, pass what this use would take as
the per-call `cost` (SDK 0.16.0 and later), so a job that costs more than
the balance is refused before it starts. Guide, "Per-call cost":
https://revturbine.com/docs/guides/entitlements/ . Where the offer stays
a slot placement for now, remove its caps.

The validator does not flag this case when the offer is not authored as
a gate. Report that as a gap if it cost you time.

Fix owner: `revturbine-author-playbook`, then
`revturbine-wire-monetization-surfaces`. Default severity: blocking.
Cause: integration choice.

## R6. A blocked action can end on a bare error

**Detect.** For every place an action is refused, read the branch where
the check denies **and** no offer is shown: the SDK is off or still
loading, the user's plan has no payload, a cap was reached, the provider
failed. Search for the refusal copy and the gate results:

```bash
rg -n -i "insufficient|not enough|upgrade required|limit reached" src
rg -n "\.ran\b|\.denied\b|deniedFallback|visible" src
rg -n "<Gate\b" src | rg -v "deniedFallback"
```

Then prove it in the app: turn the SDK off, use a plan with no payload
for that offer, and repeat the click past any cap. A red error line with
no button is the finding.

**Why it matters.** The user wanted to do the thing badly enough to
click. An error with no way to buy is the worst outcome available: no
action, no sale. It is most visible exactly when RevTurbine is not
answering.

**Intended pattern.** Every refusal has a default the app owns. Every
`<Gate>` supplies `deniedFallback`. Every click path that can be refused
opens the app's own purchase or plans screen when no offer shows. An
offer improves on the default; it never replaces having one. Also check
that every plan the app sells has a payload for each blocked-click offer.
The highest plan is the one most often forgotten.

Fix owner: `revturbine-wire-monetization-surfaces`; missing payloads are
`revturbine-author-playbook`. Default severity: blocking.

## R7. Checkout starts without the offer tag; finished purchases are not reported

**Detect.**

```bash
rg -n "checkout\.sessions\.create|billingPortal\.sessions\.create|subscriptions\.update" .
rg -n "checkoutMetadata|ctaComplete|\bconvert\(" src
```

Trace each buy button from the CTA handler to the server call that
creates the session. The finding is a session created from an offer's
button without the SDK's metadata for that output, or a successful return
that calls neither `convert` nor the controller's `ctaComplete`.

**Why it matters.** Without the tag, revenue can be counted by plan but
not by offer, so nobody can say which offer earned what. That is the
question the whole integration exists to answer.

**Intended pattern.** In the browser, `checkoutMetadata(outputId)` (SDK
0.11.17 and later) returns a `client_reference_id` and a metadata bag
for the output the user clicked, or null for an output this SDK did not
decide. Send it to the server with the chosen price. The server puts the
bag on the Checkout Session's `metadata` **and** on
`subscription_data.metadata` (or `payment_intent_data.metadata` for a
one-time purchase), and sets `client_reference_id`. On a successful
return, report the purchase: `convert(outputId)` on the SDK instance, or
`ctaComplete` on the placement that was clicked. Guide, "Tell Stripe
which placement led here": https://revturbine.com/docs/guides/billing/

**SDK gap to report.** A plan change that an existing subscriber
confirms in Stripe's billing portal cannot carry this tag; the portal
takes no metadata. If the app sends subscribers there from an offer's
button, record that those purchases are untagged and report it. Do not
invent a tagging scheme.

Fix owner: `revturbine-connect-billing`. Default severity: high;
blocking if the integration's purpose is to measure offers.

## R8. Custom actions on the generic `custom` path, filtered by an app allowlist

**Detect.**

```bash
jq -c '[.. | objects | select(.path? == "custom")] | .[] | {label, config}' "$PLAYBOOK"
jq -r '[.. | objects | select(has("path") and has("label") and has("config")) | .config | keys[]]
       | unique | join(", ")' "$PLAYBOOK"
rg -n "'custom'|\"custom\"|isSupported|allowedActions|ALLOWED_" src
```

The pattern: buttons authored as `"path": "custom"` with the real action
in a free-text config key, and app code that decides which of those
actions it will honour. The second query lists every config key in use.
Check each against `revturbine schema`; a key RevTurbine does not define
is read by nobody but the app (see R11).

**Why it matters.** RevTurbine sees one action, "custom", for buttons
that do different things, so it cannot give them roles, validate them or
report on them separately. The allowlist is a second place that must
change whenever the Playbook does, and a button missing from it fails
silently.

**Intended pattern.**

- **Use a built-in path when one fits.** The list is the CTA path enum in
  `revturbine schema`. It includes paths for inviting a teammate,
  referring a friend, managing a subscription, updating a payment method
  and switching the billing period, alongside checkout and plans. An
  "invite" button authored as `custom` usually has a built-in path.
- **Register one handler per action type** in the provider's resolver
  map, and check coverage with `validateUiPathResolvers()`, not a
  hand-written list.
- **Where no built-in path fits** (pausing a subscription, for example),
  `custom` is the only form the validator accepts today: a button path
  must be one of the built-in values. Keep it, handle it in one resolver,
  and report the missing action as an **SDK gap**. A public guide shows a
  button authored under its own action name; check any such example with
  `revturbine validate` before you recommend it, and report it as a
  **docs gap** if it does not validate.

Fix owner: `revturbine-author-playbook` and
`revturbine-wire-monetization-surfaces`. Default severity: medium.

## R9. Entitlement rules re-implemented in app or server code

**Detect.**

```bash
rg -n "plan(_handle)?\s*(===|==|!==)\s*['\"]|\.plan\s*===|tier\s*(>=|>|===)" src server backend
rg -n -i "grace|overage|allowance|rate.?limit|max_[a-z_]+\s*=|LIMITS?\s*=" src server backend
```

Look for the same rule in more than one language: browser code, a
worker, a database function or policy. Then look for facts handed to the
SDK that the SDK should have derived, such as an entitlements object the
app computed itself.

**Why it matters.** Two or three copies of one rule drift apart, and a
change in the Playbook no longer changes what users can do. A rule
enforced only in the browser is also not enforced at all.

**Intended pattern.** Rules live in the Playbook as entitlement rules.
The browser asks with `can(handle)` or a gate, passing a `cost` for
metered actions. The backend re-checks before it delivers value, with
the server SDK for its language: the headless entry of the same package
in TypeScript, `check_entitlement()` in Python, `can` in Rust. See
https://revturbine.com/docs/getting-started/server-side/ . A backend
language with no SDK is a finding to record, not a reason to copy the
rule.

**SDK gap to report.** Some rules cannot be expressed today. A bounded
grace allowance (a job may run a set amount over the balance) is one: the
enforcement modes block, degrade or allow overage with no bound, and
none allows a bounded amount. If the app re-implements a rule for that reason, report the gap
and keep the copy to one place, on the server.

Fix owner: `revturbine-author-playbook` and
`revturbine-wire-monetization-surfaces`. Default severity: high where
value moves; medium otherwise.

## R10. The app works out the user's plan itself

**Detect.**

```bash
rg -n "price_[A-Za-z0-9]{8,}|stripe_price_id|PLAN_(BY|MAP|HANDLE)|planFromPrice|planHandle\s*=" src
rg -n "customer\.subscription\.(updated|deleted)|onSubscriptionChange|subscribe\(" src server backend
rg -n "clientSession" src
```

The pattern: one or more maps from the app's subscription keys or Stripe
price ids to plan handles, a listener that pushes plan changes into the
SDK, and comments marked as assumptions about which price is which plan.

**Why it matters.** Every offer is chosen by plan. A wrong mapping puts a
user on the wrong plan for every decision, with no error. A legacy price
mapped to today's plan of the same name is the usual case. The mapping
also has to be kept in step with the Playbook and with Stripe by hand.

**Intended pattern.** Before billing is connected, the app supplies the
plan handle in the user context, and one small mapping is expected.
Once the tenant is connected and Stripe is linked, switch on the client
session: the server mints a short-lived token with the server key, the
provider's `clientSession` option fetches the user's plan, trial and
payment state, and the app's maps and listeners can go. Guide:
https://revturbine.com/docs/guides/client-sessions/ . The finding is a
hosted integration that still carries the hand-built mapping, or any
mapping that contains a guess.

Fix owner: `revturbine-connect-billing` and `revturbine-integrate-sdk`.
Default severity: high when a mapping is a guess; medium otherwise.

## R11. The app fills wording tokens the Playbook does not know

**Detect.**

```bash
rg -n "\{\{[a-z_]+\}\}" "$PLAYBOOK" | head -50
rg -n "replace(All)?\(.*\{\{|\{\{.*\}\}" src
jq -r '[.. | objects | select(has("path") and has("label") and has("config")) | .config | keys[]]
       | unique | join(", ")' "$PLAYBOOK"
```

List every token in the Playbook's copy and say who fills each one: the
SDK, the user context, or app code doing string replacement. Then check
the config-key list from R8 for keys that exist only to tell the app how
to fill something.

**Why it matters.** Copy that only the app can complete is copy the
dashboard cannot preview or change safely. A token nobody fills reaches
the user as literal braces. The opposite failure is prices and credit
amounts typed straight into the wording: they go stale the day a price
changes.

**Intended pattern.** Use the tokens the SDK derives from the plan,
usage and trial state; the SDK's `PersonalizationContext` type in the
installed package lists them. For a value only the app
knows, supply it through the user context's `personalization` values or
the slot's `personalization` prop, so the SDK does the substitution and
the Playbook stays the one place the wording lives.

**SDK gap to report.** As of 0.18.0 the SDK does not choose a pack for a
shortfall or supply tokens for a recommended pack's size and price, the
amount the user is short, or the credits a plan grants. If the app
computes those, keep the computation in one function, and report the
gap. Do not add private settings to the Playbook to steer it.

Fix owner: `revturbine-author-playbook` and
`revturbine-wire-monetization-surfaces`. Default severity: medium;
blocking if literal braces reach a user.

## R12. SDK or CLI behind the latest release

**Detect.** From the app directory:

```bash
revturbine --version
npm ls @revturbine/sdk @revturbine/cli
npm view @revturbine/sdk version && npm view @revturbine/cli version
```

`revturbine --version` prints the CLI and schema versions and compares
the installed SDK with the latest stable release. Then read the changelog
entries between the installed and latest versions, and match them
against the workarounds you found in R1 to R11.

**Why it matters.** A workaround often exists because of a gap a later
release closed. An integration that stays a version behind keeps the
workaround and misses the fix. An old pinned CLI also reports warnings
the current one no longer raises and misses rules the current one adds.

**Intended pattern.** Upgrade first, then re-run this pass: several
findings may disappear. Changelog:
https://github.com/revt-eng/revturbine-sdk/blob/main/CHANGELOG.md . Pin
the CLI to an exact version in the repo and move the pin deliberately.

Fix owner: `revturbine-integrate-sdk`. Default severity: high when a
finding in this audit is fixed by the newer version; otherwise low.

## R13. Validator warnings left in place

**Detect.**

```bash
revturbine validate "$PLAYBOOK"
```

Run it with the CLI pinned in the repo and again with the latest CLI.
Record every finding, warnings included. In hosted mode also validate
the open draft (`revturbine validate --draft`), which runs the full
server catalog.

**Why it matters.** A warning is the validator saying the Playbook will
not do what its author meant: a third button that will be dropped, a
quiet period that is ignored on a gate. The command exits successfully
with warnings present, so a build pipeline does not stop on them. Each
warning left standing is a known difference between intent and
behaviour.

**Intended pattern.** Zero errors and zero warnings on the Playbook the
app loads. Fix the cause of each warning in the Playbook. If a warning is
wrong, report it as an **SDK gap**; do not leave it and move on. If the
project has a pipeline, note that the command's exit code does not fail
on warnings today, so the pipeline must check the output.

Fix owner: `revturbine-author-playbook`. Default severity: medium, or the
severity of the behaviour the warning describes.

## R14. A workaround for a missing SDK capability, with no report

**Detect.**

```bash
rg -n -i "workaround|work around|sdk (does not|doesn't|cannot|can't|has no)|until the sdk|revturbine.*(todo|fixme|hack)" .
rg -n -i "assumption|not yet supported|to[- ]do" docs notes *.md
```

Also read the names of the helpers around SDK calls. A function that
decides when to ignore the SDK's answer, delays SDK start, or
re-derives something the decision already carries is a workaround,
whether or not a comment says so. For each one, ask where it was
reported: an issue link, a message, a ticket.

**Why it matters.** Each workaround is reasonable alone. Together they
hide the real state of the integration, and the gap stays open for every
other team. A workaround with a report is a stopgap with an end date. A
workaround without one is permanent.

**Intended pattern.** A missing capability stops the work on that piece
and becomes a report the same day: what was needed, the versions, the
smallest reproduction, and the workaround with its file and symbol.
`revturbine-start-here` → If you get stuck has the route. List every
unreported workaround in the report's closing section, each with a
drafted report.

Default severity: medium each; raise the audit's overall verdict when
there are several.

## R15. The bundled Playbook differs from the launched Release

**Detect.** With the tenant connected and after `revturbine whoami`
confirms it:

```bash
revturbine diff "$PLAYBOOK" --live
revturbine status
git log --oneline -- "$PLAYBOOK"
```

Any difference is a finding to explain. Check the history of the file:
edits committed in the app's branch that never went through validate,
upload and launch are the pattern. With no tenant connected, the finding
is narrower: say that the file is the only copy, and check it validates
clean (R13).

**Why it matters.** A Playbook in the repo is trusted because it matches
something that was validated and launched. An agent that edits the copy
in the branch to make a test pass has changed what users will see
without any of the checks that surround a launch, and without the person
who owns the monetization plan reading the change. In local mode the app
then ships that file.

**Intended pattern.** The validated, launched Playbook is the one that
counts. Edits go through `revturbine validate` with no warnings, are
staged with `upload`, read by a human, and launched by a human; the file
in the repo is then replaced with the launched version. See
`revturbine-release-lifecycle`.

Fix owner: `revturbine-release-lifecycle`. Default severity: high.

## R16. An offer reused at a moment it was not written for

**Detect.** For each slot id, list every place the app asks for it:

```bash
rg -n "SLOTS?(_IDS?)?\.|slot(Id)?:\s*['\"]|<Slot[^>]*\bid=" src
```

Adjust the first alternative to the name of the app's own slot-id
constants.

Group the call sites by what the user was doing. One slot id requested
from two screens with different intent is the finding: a cancellation
offer also shown when a subscriber opens Billing to update a card, or an
out-of-credits offer also shown on a pricing link. Also look for a
"moment" or "context" passed as slot metadata to make one slot behave
like several.

**Why it matters.** The wording is wrong for the second moment, since it
suggests leaving to someone who did not ask to leave. And it spends the
offer's frequency limit there, so the offer is gone when the real moment
comes.

**Intended pattern.** One slot per moment, named for the moment. If two
moments should show the same content, author two placements that share
the content, each with its own trigger and limits.

Fix owner: `revturbine-wire-monetization-surfaces`, then
`revturbine-author-playbook`. Default severity: high; blocking when it
consumes a once-only offer.
