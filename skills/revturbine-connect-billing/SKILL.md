---
name: revturbine-connect-billing
description: >
  Link RevTurbine to Stripe — connect the account, map each Playbook
  price to a real Stripe price, and prove Stripe's events flow back into
  RevTurbine. Writes config, not checkout: the app owns its checkout
  flow. Use when someone says "connect Stripe", "connect billing", "map
  the prices", "make the prices real", "hook up payments", or when a
  purchase in Stripe leaves no trace in RevTurbine ("paid but still on
  Free"). Skip if the job is wiring gates and
  slots (revturbine-wire-monetization-surfaces), authoring the Playbook
  (revturbine-author-playbook), or launching
  (revturbine-release-lifecycle). Load revturbine-start-here first if
  this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.4.1"
  safety_class: writes-config-draft
  schema_version: ">=0.1.0 <0.2.0"
  tier: free
---

# RevTurbine — Connect Billing

You are linking RevTurbine to your human's Stripe account. When you are
done, every price in the Playbook is a real Stripe price, and Stripe's
events flow into RevTurbine on their own: purchases, payment failures
and recoveries, trial starts, price changes.

Once connected, **a purchase updates the user's plan by itself**: the
plan flows Stripe → RevTurbine → the SDK's decisions, with no app code
in the path. Before billing is connected (and always in local mode),
the app is the plan's only source.

This skill builds no checkout. The app owns its checkout flow, and
`revturbine-wire-monetization-surfaces` connected the button. What
changes here is what stands behind the button: the plan it offers now
carries a real price, and the purchase leaves a record without the app
doing anything.

Money is the highest-consequence wiring in the catalog, so two rules
hold throughout. **Your human performs every action inside Stripe
themselves** — you prepare them for each screen and verify the result;
you never handle credentials or click on their behalf. And **everything
is proven in Stripe's test mode** before live mode is discussed.

## Establish what billing looks like today

- **Does the business have a Stripe account**, with its products and
  prices already in it? Usually yes — that account is what gets
  connected, catalog and all.
- **Does the app already have its own checkout and its own Stripe
  webhooks?** Both keep working. RevTurbine's event flow is separate
  and additive; nothing here replaces the app's own billing records.
- **Do they need this yet?** A product with fixed prices and app-owned
  billing can run RevTurbine with static prices
  (`price_source: "static"`) indefinitely. Connect billing when prices
  should follow Stripe and Stripe's events should reach RevTurbine on
  their own.

Then read the Playbook: every plan and add-on variation is a row of
mapping work — each needs a real Stripe price id, or a deliberate
`"static"` marking.

## Connect the Stripe account

Your human's job, in the RevTurbine dashboard (Settings → Billing). Two
paths:

- **They have a Stripe account** — the normal case. They click connect,
  sign in to Stripe, and authorize the access. Tell them beforehand
  exactly what they will approve: **read and write access** to their
  Stripe account. Today RevTurbine reads the price catalog and receives
  billing events; the write half is granted up front so later features
  need no re-authorization. The connection can be revoked from Stripe
  at any time.
- **They have no Stripe account** — the embedded setup on the same
  screen creates one, walked through inside RevTurbine.

**No API key is ever pasted, anywhere.** That path does not exist, and
anything asking for one is not RevTurbine.

Afterwards, confirm two things: the account shows as connected, and the
Stripe price catalog has synced in. "Connected" is the bar — an
incomplete Stripe onboarding profile is informational and blocks none
of the mapping work; completing it matters only once real charges
start.

## Map the prices

Line each Playbook variation up with its Stripe price:

- set `stripe_price_id` to the real id and `price_source` to
  `"stripe"`;
- resolve every price placeholder `revturbine-author-playbook` left on
  its corrections list;
- **one Stripe price links to at most one RevTurbine object.** The
  dashboard enforces this when linking there; the Playbook route is
  only partly covered, so check it yourself — in particular, the same
  id on a plan variation and an add-on variation is caught nowhere.

The ids come from the synced catalog in the dashboard's billing
screens, or from the Stripe dashboard directly — same ids. The
dashboard can also link prices without touching the file; the Playbook
route keeps the mapping versioned with everything else, so prefer it.

Two facts govern the numbers. **The Playbook's `price_amount` is
display copy; Stripe is the number that charges** — never present the
Playbook figure as authoritative. And **validation barely covers this
mapping**: the offline check does not catch a missing price link today,
and the server-side check (`revturbine validate --draft`) reports it
for plans only, as a warning — an unmapped add-on variation surfaces
nowhere. Verify the mapping row by row yourself.

## Prove the flow in test mode

RevTurbine receives the Stripe events for the connected account itself
— **neither your human nor the app configures a webhook for this.**
What flows in: the subscription and its changes, recorded on the
customer; a payment-attention signal (`payment_at_risk`) that the
payment-recovery placements read; trial state from trialing
subscriptions; and price changes into the synced catalog.

Prove it with fake money, end to end. For the Stripe half of every step
— test cards, test clocks, simulated events (`stripe trigger`) — the
Stripe CLI and Stripe's own testing docs are the reference; do not
improvise Stripe mechanics from memory.

1. Agree with your human how to exercise test mode — normally the
   app's own checkout, in Stripe test mode, with a Stripe test card —
   and buy a mapped plan.
2. Confirm RevTurbine recorded it: the subscription change appears on
   that customer's record in the dashboard, with no app code in the
   path.
3. Confirm the user's access flips with no app code: a gated feature
   reads denied before the purchase and allowed after — the plan
   arrived from billing, not from the app. **Re-mount or reload the
   screen before reading the second result**: a gate already on screen
   holds its previous answer, so testing without a reload shows a stale
   "still denied" and sends you hunting a billing bug that isn't there.
4. Fire a payment failure (a declining test card) and confirm the
   payment-attention signal turns on. Recovery clears it on the
   customer record; the SDK's held context does not clear itself
   mid-session — re-read the context to see it drop.

**"Paid in Stripe, invisible in RevTurbine" is the failure this skill
exists to prevent.** If step 2 shows nothing, the fault is on
RevTurbine's side of the event flow: do not patch around it in app
code — report it (`revturbine-start-here` → If you get stuck).

Live mode enters the conversation only after this passes, and going
live is `revturbine-release-lifecycle`'s to prepare — never yours to
flip.

## What changes in the app

One edit, routed through `revturbine-wire-monetization-surfaces` since
it is app code: **the checkout stub becomes real** — the
`open_checkout_modal` resolver now opens the app's checkout carrying the
mapped plan's real price.

And one deletion: **any hand-written plan update after purchase is now
scaffolding** — the plan follows billing, so remove the app's own
post-checkout `update()` call rather than leaving two writers of the
same fact.

Apps that keep their own Stripe webhooks keep them — they serve the
app's own records, not RevTurbine.

## Not yet

Some billing features are authored intent today, not execution. Say so
to your human rather than letting the config imply otherwise:

- **Promotions do not discount.** An authored promotion reaches the
  surface for the app to render, but no discount is applied to the
  purchase — the app passes its own coupon to its own checkout.
- **Overage is permitted, not metered.** The `allow_overage`
  enforcement lets the action through and labels it, but RevTurbine
  writes no usage to Stripe — billing overage means the app reporting
  metered usage to Stripe itself, and Stripe charging from that.
- **Extra seats are bought, not synced.** Model them as an add-on with
  its own Stripe price, purchased through the app's checkout; RevTurbine
  writes no seat quantities to Stripe.
- **Card-required trials start in the app.** RevTurbine reads the
  trialing subscription back from Stripe's events; creating it is the
  app's checkout's job.

## Where to go next

- **Make the app-side deletions, or wire the UI in the first place** —
  `revturbine-wire-monetization-surfaces`.
- **Audit everything before launch** — `revturbine-verify-integration`.
- **Go live** — `revturbine-release-lifecycle`, your human's call.
- **Change what is sold** — `revturbine-author-playbook`; new prices
  come back through the mapping step here.

## If you get stuck

The docs' billing & Stripe guide covers the connect flow, webhooks and
test-mode verification — point your human there when they want to read
rather than be walked through. Stripe's own docs and the Stripe CLI are
the reference for the Stripe half. Field shapes come from
`revturbine schema`; command syntax from `revturbine <command> --help`,
never from memory. For anything else, follow `revturbine-start-here` →
If you get stuck.
