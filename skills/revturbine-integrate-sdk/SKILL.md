---
name: revturbine-integrate-sdk
description: >
  Put RevTurbine into an app for the first time — install the SDK, mount
  the provider, identify the user, and close the loop by confirming one
  entitlement decision changes when the plan changes. Also handles SDK
  upgrades, and the local-to-hosted provider swap when
  revturbine-release-lifecycle delegates it. Writes app code, and monetizes
  nothing: no feature is gated and no prompt appears. Use when someone
  says "add RevTurbine", "install the SDK", "set up the provider", "get
  RevTurbine working", or when hooks and components fail because no
  provider is mounted. Skip if the provider is already mounted and
  resolving in the mode your human wants — go to
  revturbine-wire-monetization-surfaces to gate features, or
  revturbine-verify-integration if it misbehaves. Load
  revturbine-start-here first if this session hasn't.
license: MIT
metadata:
  author: revturbine
  version: "0.7.1"
  safety_class: writes-app-code
  schema_version: ">=0.1.0 <0.2.0"
  sdk: "^0.2.77"
  tier: free
---

# RevTurbine — Integrate the SDK

You are putting RevTurbine into an app that does not have it. When you are
done, the SDK is installed, the provider is mounted, the user is
identified, and RevTurbine is answering questions about what that user may
do.

**This skill monetizes nothing.** No feature is gated, no upgrade prompt
appears, no plan is enforced, and no product behaviour changes. Deciding
what to charge for is `revturbine-author-playbook`; gating features and
placing monetization surfaces in the UI is
`revturbine-wire-monetization-surfaces`; taking it live is
`revturbine-release-lifecycle`. Your job is the plumbing those three rely
on.

The last step is a **closed-loop test**, not an objective of its own: read
one entitlement, change the user's plan, confirm the answer changes, then
delete the test. It gates nothing — it displays a value. You need it
because a working integration and a broken one are otherwise
indistinguishable: both render the app exactly as before.

That is also the standard to hold throughout. The app must build and render
as it did before, and **never require RevTurbine to render** — if removing
the provider breaks a page, something is gating on its presence, and that
is the one thing this skill must not leave behind.

## Establish what you are integrating into

Find these before you write code.

- **The frontend framework and where its tree begins** — the provider
  mounts once, at the root.
- **The package manager** — from the lockfile, not from habit.
- **Whether a Playbook already exists** in the repo, and where. It has no
  fixed location; follow any existing provider import
  (`localRuntime: { playbook }`).
- **The backend language**, because revenue-critical checks get re-verified
  there. You do not wire that here, but find out now whether it is
  possible: RevTurbine ships a server SDK for some languages and not others
  (docs: Getting started). **Where there is none, there is no published
  HTTP API to substitute** — do not invent a call. Tell your human now
  rather than at launch, and where it blocks the launch, offer to open an
  issue on the RevTurbine SDK repo naming the language.

Then classify the state (`revturbine-start-here` → Determine the current
RevTurbine state). If the provider is already mounted and a Playbook is
resolving, you are in the wrong skill.

## Install

Two routes. Prefer the scaffold — it installs both packages at the versions
that work together and leaves an example Playbook behind:

```bash
npm create revturbine@latest   # or, where the CLI is pinned: revturbine init
```

The scaffold detects the stack and package manager, installs the SDK and
the CLI, writes the example Playbook at the repo root, and installs the
RevTurbine Agent Skills (`--no-skills` opts out; `--dry-run` reports
without installing). **It never edits app code** — mounting the provider is
yours, below.

If you cannot run the scaffold, install both packages with the app's own
package manager — `@revturbine/sdk` and `@revturbine/cli` — and mirror
the scaffold's pins: the SDK on a caret range, the CLI exact
(`--save-exact`, as a dev dependency). The CLI's *binary* is
`revturbine`; the npm package `revturbine` is only the scaffold
launcher, not the CLI.

The packages declare their own Node and React requirements — check the
install output for engine warnings; npm warns on a mismatch rather than
stopping. Apps not built on React use `@revturbine/sdk/headless` — session
setup is in the docs' Headless API guide; the user context and the
closed-loop test below apply unchanged.

## Mount the provider

The provider is a small component that sits at the top of the app. It
creates the SDK once and holds it, so everything below asks the same
instance. Wrap the root of the component tree with it, at the framework's
entry point — `app/layout.tsx` (Next.js App Router), `pages/_app.tsx`
(Pages Router), `main.tsx` or equivalent elsewhere.

The shape below is illustrative, not a file to copy verbatim — the
component name, the accessor for the signed-in user, and the import paths
are the app's own. The two sections after this one explain its two main
options: which Playbook to decide against, and who the user is.

```tsx
'use client';

import { RevTurbineProvider } from '@revturbine/sdk';
import { useMemo, type ReactNode } from 'react';
import playbook from './revturbine.playbook.json';

export function Providers({ children }: { children: ReactNode }) {
  // The app's own accessor. Resolve it before mounting the provider.
  const user = useCurrentUser();

  const options = useMemo(() => ({
    localRuntime: { playbook },
    user: {
      id: user.id,
      plan: { id: user.planHandle, name: user.planName },
    },
    uiPathResolvers: {},
  }), []);   // built once, deliberately — see below

  return (
    <RevTurbineProvider options={options}>{children}</RevTurbineProvider>
  );
}
```

**Build the options object once — the empty dependency list is
deliberate.** The provider re-initializes the whole SDK whenever the
options object changes, and warns about it in development. So the options
carry only what is fixed for the app's lifetime, plus a first snapshot of
the user. Anything that changes after mount — a login, a plan change —
goes through the user-context calls in the next section, never back
through the options.

**This wrapper calls hooks, so under the Next.js App Router it is a client
component.** Keep `'use client'` at the top and import the wrapper into
the server layout; do not convert the layout itself.

**Give `uiPathResolvers` an entry for each CTA action type the Playbook
declares.** A CTA is what an upgrade button does when someone clicks it —
open checkout, show the plans page, book a demo — and the resolver is the
app's code for doing it. The example Playbook has no CTAs, so an empty map
is right for now. Filling these in is
`revturbine-wire-monetization-surfaces`'s job, and it must happen in the
same change as any Playbook that adds one.

**Then check it started.** `useRevTurbine()` reports `isReady` once the SDK
is running, and `error` when it is not. Check it rather than assuming: a
provider that failed to start still lets the app render normally, so
nothing looks wrong from the outside.

## Load the example Playbook

The SDK decides nothing until it has a Playbook to decide against.
RevTurbine ships one for this step: the scaffold writes
`revturbine.playbook.json` at the repo root, holding a `free` plan, a `pro`
plan, and one entitlement, `advanced_export`, granted to `pro` only. It is
a test fixture — enough to prove the wiring and nothing more. **It has no
placements**, so nothing renders from it, and that is expected rather than
a fault.

```tsx
import playbook from './revturbine.playbook.json';
// ...
localRuntime: { playbook }
```

Importing JSON needs `resolveJsonModule` in `tsconfig.json`.

Supplying a Playbook this way puts the SDK in **local mode**: it reads the
file directly, so there is no tenant connection and no decision traffic —
and no account is needed. A first integration always works in local mode.
Deciding to go hosted — where RevTurbine serves the Playbook and it
changes without a redeploy — is `revturbine-release-lifecycle`, when your
human is ready; when it does, it sends the provider edit back here
(below).

One piece of network traffic remains in every mode, this one included: a
keyless install beacon carrying config-shape counts and a hashed config id,
never user data. Opt out with `anonymousTelemetry: false`. Tell your human
it exists rather than letting them find it in a network tab.

If the repo already has a real Playbook, use that instead, and pick any
entitlement it grants to one plan and not another. Authoring a real one is
`revturbine-author-playbook`.

## Set the user context

RevTurbine decides for a specific user and knows only what the app tells
it. Two fields matter now: the id, and the plan.

```tsx
user: {
  id: user.id,
  plan: { id: 'pro', name: 'Pro' },
}
```

**Put the plan in `plan`.** It takes the plan's **handle** — the short,
stable name the Playbook knows that plan by — and its display name. Both
are required. A plan supplied under some other key is not read, and every
entitlement check then denies.

**If the app has no plans yet, that is normal** — it is often why
RevTurbine is being added. Set the plan to the example Playbook's `free`
plan and carry on. Wiring real plans arrives with billing
(`revturbine-connect-billing`).

Then the rules for the id, which the SDK does not enforce for you:

- **The app always supplies the id.** RevTurbine decides for identified
  users only — there is no anonymous mode to fall back on. Supporting
  visitors who are not signed in is on the roadmap, not shipped, so keep
  RevTurbine off pre-signup surfaces for now.
- **Stable, non-guessable, and never an email address.** An email in the id
  puts personal data into every decision.
- **The same id on the browser and the backend.** A backend keyed by
  database id and a browser keyed by email give confident, unrelated
  answers on each side, and nothing notices.

For changes after mount: a different person signs in (`identify()`);
anything else about the same person changes with `update()` — it accepts
the whole user context except the id, so a plan change, a trait, and a
usage balance all go through the same call. A new id is a new person,
which is `identify()`'s job alone.

## Close the loop

Read one entitlement, change the plan, and confirm the answer changes. This
component displays a value and gates nothing:

```tsx
import { useEntitlement } from '@revturbine/sdk';

function RevTurbineCheck() {
  const { allowed } = useEntitlement({ handle: 'advanced_export' });
  return <span>advanced_export: {allowed ? 'allowed' : 'denied'}</span>;
}
```

**Change the plan by hand** — edit the value in the provider options
between `free` and `pro`, reload, and watch the answer flip. The app's own
plan wiring does not need to exist yet; testing against the example
Playbook is what makes that possible.

On `free` it reads **denied**; on `pro`, **allowed**. Two observable
states, so a pass looks different from a failure. Do not test with a slot
or a gate instead: those render nothing when the integration is broken and
nothing when the Playbook has no placements, so they cannot tell you which
happened. **Delete the component once it has passed** — the app ends this
skill with no RevTurbine-dependent UI in it.

Then tell your human, briefly: the SDK is in, decisions resolve locally
against the example Playbook, nothing is gated yet, and the next step is
theirs to choose.

## When release-lifecycle sends you here

Going live is `revturbine-release-lifecycle`'s job, but the provider
options are app code, so it delegates this one edit: replace
`localRuntime: { playbook }` with the tenant connection options — the
tenant, its API key, and the ingest key release-lifecycle minted. Nothing
else changes: components, user context and resolvers stay as they are. Make
the edit, confirm the app still renders, and hand back — the launch stays
with release-lifecycle.

## Upgrade an existing integration

The other job this skill handles: a later session where RevTurbine is
already integrated and the SDK or CLI needs updating. Skip this section
entirely on a first install.

Update the package, then re-run the closed-loop test above to confirm
decisions still resolve. When the CLI moves, also re-validate the
Playbook: the CLI carries the schema the Playbook is checked against, and
a Playbook written for a newer schema can carry fields an older CLI
**silently drops rather than flags** — validation comes back clean and
the fields are gone.

## Where to go next

- **Gate features and place monetization surfaces** —
  `revturbine-wire-monetization-surfaces`, which also fills in the real
  `uiPathResolvers` bodies.
- **Author a real Playbook** — `revturbine-author-playbook`.
- **Go live and make the Playbook changeable without a deploy** —
  `revturbine-release-lifecycle`.
- **Something misbehaves** — `revturbine-verify-integration`.

## If you get stuck

Command syntax comes from `revturbine <command> --help`, never from memory;
field shapes from `revturbine schema`. For anything else, follow
`revturbine-start-here` → If you get stuck.
