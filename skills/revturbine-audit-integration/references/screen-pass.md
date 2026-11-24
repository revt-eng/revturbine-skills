# The screen pass — look at every offer

*Reference for `revturbine-audit-integration`. The rules pass proves
which offer shows and when. This pass judges what the user sees. It
needs a running app and screenshots; if you have neither, report the
pass as not done.*

A check that pulls the text of a dialog and compares it with the
Playbook proves the right offer shows. It says nothing about layout,
order, or whether the main button is the best deal. Screens pass that
kind of check and are still bad: a pack with no button of its own, three
buttons stacked under two boxes, a dialog taller than the window, an
upgrade prompt that removed an option the app used to offer. Only looking
finds these.

## What you need

- **The app before the integration**: production, or the base branch,
  running and signed in.
- **The app with the integration**, with a way to become each plan: test
  accounts, or the app's own demo or debug switch. Include the lowest
  plan, every paid plan, the highest plan, and any legacy plan that still
  has subscribers.
- **A browser you can drive and capture**, set to a laptop window. Use
  1440 by 900 as the default and repeat the tallest screens at 1280 by
  720. If the app is used on phones, add one phone size.
- **The intent you collected** before the rules pass: the monetization
  plan and the standing decisions.
- **A way to reset frequency limits** between runs: clear the site's
  storage, or use a fresh browser profile. Limits and quiet periods kept
  in the browser apply per device.

## Step 1 — Baseline first

Before you open the branch, open today's app and capture every screen an
offer will touch: each place an action can be refused, the header, the
navigation, the share and download flows, settings and billing, and the
cancel flow. For each one write down what the user can do there today:
which purchases are offered, at what prices, with what explanation.

This is the step most often skipped, and it is the only one that finds
regressions. Typical findings: the new prompt offers only a subscription
where today's screen also sold one-time packs; today's dialog explained
cost against balance and the new one does not; a header that had a
button and a separate balance now has one merged control.

## Step 2 — Look, do not read

For each slot and gate the integration adds, and for each plan, trigger
the offer and capture the screen at the laptop size. Capture the whole
window, not the component, so you can see what is cut off and what sits
beside it.

Keep a grid: rows are offers, columns are plans. Every cell gets a
screenshot or the words "no offer". **An empty cell is a finding to
explain**, never a pass by default. A plan with no offer at a blocked
action is a dead end (R6 in the rules reference).

Look at each picture before you read the component that drew it.

## Step 3 — Judge against the short standard

Ask six questions of every screen. A "no" is a finding.

1. **Does it say why the user is seeing it?** One line that names the
   cause in the user's terms: what the job needs and what they have, or
   what the feature is and which plan includes it. A warning icon and a
   sentence that repeats the buttons is not a reason.
2. **Does one best offer come first?** The first and most prominent
   offer should be the best deal that lets the user finish what they
   started. Work it out: for each option, the price, what it gives, and
   the price per unit. A prominent button that sells less for more than
   the option beside it is a finding. So is an offer that does not cover
   what the user needs.
3. **Does each offer have its own button and price?** Each option is a
   unit: name, what it gives, price, button. A box with no button, or a
   row of buttons separated from the things they buy, makes the user
   match them up.
4. **Is there one way to close?** A close control and a "Not now" button
   and a "Maybe later" link are three ways to do one thing. Keep one. A
   button that lets the user carry on with the action in a lesser form
   (download with the watermark, continue anyway) is a real choice and
   is not a close control.
5. **Does it fit the window?** The main button is visible without
   scrolling at the laptop size. A card in a sidebar shows its button
   without scrolling the sidebar. Nothing is clipped.
6. **Is anything worse than the baseline?** Compare with Step 1. An
   option removed, an explanation dropped, an extra step added, two
   purchase buttons where there was one.

Also check, on every screen: copy with unresolved `{{tokens}}`; prices
or amounts that disagree with the plan data; two prompts asking for
different things at once (an invite card beside a share control); an
offer aimed at the wrong person (a cancel option shown to someone with
no subscription, an upgrade button shown on the highest plan).

## Step 4 — Walk the journeys

A screen can pass alone and fail in sequence. For each plan, walk each
journey from the trigger to the purchase and back, **more than once**.

- **Repeat the click.** Trigger the same offer, decline it, and trigger
  it again, at least ten times. Watch for the offer changing on a later
  click, another offer taking its place, or a bare error once a
  frequency limit is reached. An offer that answers a blocked action
  must show every time.
- **Cross the slots.** Trigger one offer, then go to a different screen
  and trigger another. Watch for an offer written for one moment showing
  at another, and for a once-only offer being used up by an unrelated
  screen so it is missing when its own moment arrives. Test the pairs
  that share a design or a plan: an out-of-credits prompt and a cancel
  prompt, a download prompt and a share prompt.
- **Follow the money.** Click each buy button through to checkout in
  test mode or the app's demo mode. Note where it lands: checkout for
  the offered item, a different item, a plans page, or straight to
  payment with no description of what is being bought. Come back and
  confirm the app reflects the purchase.
- **Take the exits.** Close the offer every way it allows. The user
  should be back where they were, able to carry on or try again.
- **Break it.** Repeat the main journey with the SDK disabled or its
  Playbook request blocked, and with a plan the Playbook does not know.
  The app must still offer a way forward at every refused action.
- **Count the steps.** Two dialogs in a row before the user reaches the
  thing they clicked is a finding, as is a dialog in the middle of the
  screen followed by a panel in a corner.

Record each walk as a short numbered list of what you clicked and what
appeared, so someone else can repeat it.

## Step 5 — Show the pictures

Put each screenshot in the findings beside its verdict. For a regression,
put the baseline and the new screen side by side. For a journey finding,
show the frames in order.

A reader who can see the screen can disagree with you, and that is the
point. A finding described only in words asks the reader to trust the
description. The audits that missed bad screens were the ones that listed
a dialog's buttons accurately in a table and moved on.

## Step 6 — Check the intent

Compare each screen with what the business decided, not with what the
branch says it built.

- Go through the plan and the standing decisions one by one, and point at
  the screen that satisfies each. A decision with no screen is a finding.
- Go through the grid from Step 2, and for each empty cell ask whether
  anyone decided that plan should get nothing there. If nobody did, it is
  a gap, whatever the tests assert.
- Read the branch's notes and tests last, and only to find claims to
  verify. "Expected: no offer for this plan" in a test is a description
  of the build, not a decision.

## Writing a screen finding

- **Where**: the screen and how to reach it, for which plans.
- **What happens**: what the user sees, in plain words, with the
  screenshot.
- **Against the standard**: which of the six questions it fails, or which
  decision it misses.
- **Compared with the baseline**: better, the same, or worse, and how.
- **Fix**: what the screen should be. Say whether the fix is Playbook
  content (`revturbine-author-playbook`), app layout or wiring
  (`revturbine-wire-monetization-surfaces`), or a limit of the SDK's
  built-in component to report to RevTurbine.
- **Evidence for the builder**: the component and symbol that draws it,
  and the slot or gate id.
