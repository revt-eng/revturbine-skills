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
  version: "0.12.1"
  safety_class: writes-app-code
  schema_version: ">=0.1.0 <0.2.0"
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

**Run it through the app's own provider, and confirm the provider
started.** A standalone script that imports the Playbook file directly
proves the file, not the wiring — it passes while the running app is dead,
because it never exercises the options the app actually builds. Mount the
check inside the app, and before you read any decision read
`useRevTurbine()`: if `initStatus.ok` is `false`, `phase`, `message` and
`remediation` say what failed and what to change, even when `sdk` is `null`.
If it is `true`, still wait for **`isReady` and a non-null `sdk`** before
reading decisions: `ok` also starts as `true` while initialization is
pending. An initialization failure is reported without stopping the host
app from rendering. (`initStatus` arrived in `@revturbine/sdk` 0.8.0; on an
older version use `isReady`, `sdk` and `error`.)

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

Two routes. Prefer the scaffold — it installs missing dependencies and
creates a starter Playbook for a fresh integration:

```bash
npm create revturbine@latest   # or, where the CLI is pinned: revturbine init
```

The scaffold detects the stack and package manager, requests the latest SDK
when it is missing, pins the CLI exactly, and installs the RevTurbine Agent
Skills (`--no-skills` opts out; `--dry-run` reports without installing).
Existing dependency declarations and integrations are preserved. **It never
edits app code** — mounting the provider is yours, below.

If you cannot run the scaffold, install both packages with the app's own
package manager — request `@revturbine/sdk@latest` and install
`@revturbine/cli` exactly (`--save-exact`, as a dev dependency). Let the app's
package-manager settings determine the SDK's saved exact/range declaration;
neither syntax is an SDK freshness check. The CLI's *binary* is
`revturbine`; the npm package `revturbine` is only the scaffold
launcher, not the CLI.

The packages declare their own Node and React requirements — check the
install output for engine warnings; npm warns on a mismatch rather than
stopping. Apps not built on React use `@revturbine/sdk/headless` — session
setup uses the same awaited session API as the root entry:

```ts
import { initRevTurbine } from '@revturbine/sdk/headless';
import playbook from './revturbine.playbook.json';

const session = await initRevTurbine({
  localRuntime: { playbook },
  user: { id: 'user_123', plan_handle: 'free' },
});
const result = await session.can('advanced_export');
const branding = session.sdk.getBranding();
```

`initRevTurbine` returns a Promise of a session; instance-only methods live
on `session.sdk`. Use the app's actual user, plan and entitlement handles.
The public initializer preserves identity, plan and custom context without
a redundant `id` warning from SDK 0.9.2. See the
[Headless API guide](https://revturbine.com/docs/guides/headless-api/).
The user context and closed-loop test below apply unchanged.

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
      plan: { handle: user.planHandle, name: user.planName },
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

**Then check it started.** Read `initStatus` first, then require `isReady`
and `sdk` before treating the provider as initialized. Check inside this
mounted provider: a provider that failed to start still lets the app render
normally. Development failure banners and theme-override warnings work in
published SDK packages from **0.8.9**; earlier 0.8.x packages have the
`initStatus` probe but unreliable development diagnostics. `initStatus`
remains available in production. See the
[React status example](https://revturbine.com/docs/getting-started/react/#userevturbine).

Local mode needs no placeholder `tenantId`, `publicKey` or endpoint. Supply
user context for the identity and rules your app uses, CTA resolvers for
authored action types, and optional `branding` in `options`. Set the
placement palette with `colorScheme="light"`, `"dark"` or `"system"`
directly on `RevTurbineProvider`, outside `options`; see
[theming](https://revturbine.com/docs/guides/theming/).

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

An optional keyless install beacon can run in local mode, carrying
config-shape counts and a hashed config id, never user data. Opt out of that
beacon with `anonymousTelemetry: false`; this is not a global network switch.
Tell your human it exists rather than letting them find it in a network tab.

If the repo already has a real Playbook, use that instead, and pick any
entitlement it grants to one plan and not another. Authoring a real one is
`revturbine-author-playbook`.

**A Playbook reaches the SDK one of two ways: imported from a file checked
in with the app, or served by RevTurbine.** Do not put the app's own
endpoint in between — a backend route that fetches, reshapes or strips
fields from the Playbook before handing it to the provider hands the SDK
something the Playbook's own validation never saw. Preserve the validated
artifact, including `tenant_id` when present. An explicit `tenantId` init
option is authoritative, but remains optional in local mode. In hosted
mode keep the endpoint pointing at RevTurbine; `custom_endpoints` can route
context and telemetry through a proxy, not Playbook delivery. See
[runtime modes](https://revturbine.com/docs/guides/runtime-modes/#keep-the-playbook-intact).

### Which key goes where

Hosted mode introduces two different credentials. Naming a browser sample
with the wrong one either leaks a secret or breaks the app, so keep them
separate:

| Key | Init option | Lives where | Never |
|---|---|---|---|
| Public ingest key (from `revturbine ingest-keys create`) | `publicKey` on `RevTurbineProvider` / browser `initRevTurbine` | Shipped in the browser bundle, in app code | — it is meant to be public |
| Server key (tenant API key) | `apiKey` on `@revturbine/sdk/server` (Node, Python, Rust) | Backend process only (env var, secrets manager) | In any browser bundle or client-side code |

As of SDK **0.11.0**, `publicKey` is the only browser option name —
the deprecated aliases `ingestPublicKey` and `apiKey` were removed from
the browser entry points. On SDK 0.10.x both aliases still work on the
browser but emit a development-only warning to switch to `publicKey`.
The server SDK's `apiKey` is unrelated and unaffected by this rename.

## Set the user context

RevTurbine decides for a specific user and knows only what the app tells
it. Two fields matter now: the id, and the plan.

```tsx
user: {
  id: user.id,
  plan_handle: 'pro',
}
```

**The plan's identity is its handle.** Supply it flat as `plan_handle`,
or as `plan: { handle, name }` when you also want the display name:

```tsx
user: {
  id: user.id,
  plan: { handle: 'pro', name: 'Pro' },
}
```

The handle is the short, stable name the Playbook knows that plan by —
its `unique_handle`. The key name matters: a bare string
(`plan: 'pro'`) or the old `plan: { id }` is **not read**, and a user
with no bound plan **fails closed** — every plan-targeted rule misses
and the check denies with `reason: 'no_plan_identity'`.

Verify by checking a paid-only entitlement as a free user and confirming
a **denial**. If instead you see denials *everywhere*, including on plans
that should be granted, read the `reason`: `no_plan_identity` means the
plan never bound, and the usual cause is still passing `plan: { id }`.

> **Version note.** `plan: { id, name }` was correct through SDK 0.2.x
> and stopped resolving in 0.3.0, when the plan object's identity field
> was renamed `id` → `handle` (the `id` was a database-internal value the
> client often did not have — and in practice was usually populated with
> the handle anyway). On **0.2.x an unbound plan GRANTED** rather than
> denying: plan targeting was skipped rather than failed, so a mis-keyed
> plan handed every user the paid feature silently. The public changelog records
> fail-closed behavior from **0.3.0 in TypeScript and 0.4.0 in Python/Rust**.
> On older releases, the
> paid-only-as-free-user check above is the one that catches it, and an
> `allowed: true` there means the plan never bound.

**If the app has no plans yet, that is normal** — it is often why
RevTurbine is being added. Set the plan to the example Playbook's `free`
plan and carry on. Wiring real plans arrives with billing
(`revturbine-connect-billing`).

Then the rules for the id, which the SDK does not enforce for you:

- **Supply the signed-in user's id.** Omitting `user` intentionally uses
  an anonymous identity. An explicitly blank id logs an error and falls
  back to an anonymous id; it does not stop the host app. Neither should
  stand in for a signed-in user: caps, usage and analytics would attach to
  the wrong identity. Resolve the app's user before mounting when checks
  depend on that identity. (`identify('')` is refused.)
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

Run `revturbine --version` from the app directory. CLI 0.19.1 and later
check npm's latest stable SDK release and report SDK guidance on stderr,
alongside the unchanged CLI/schema version on stdout. `revturbine init`
also checks its target project. Use the reported concrete SDK version for
the upgrade, preserving the app's exact/range convention. A caret range
that allows the latest version can still have an older installed version;
the CLI checks the installed SDK when available and labels a declaration
fallback when it cannot resolve one. An unavailable check is not proof
that the app is current. Existing dependencies are never upgraded by this
advisory or by rerunning init.

Update the package, then re-run the closed-loop test above **in the
running app** — a version jump can change what the provider accepts, so
confirm it still initializes (`initStatus.ok`, `isReady` and non-null `sdk`) before you confirm decisions
still resolve. When the CLI moves, also re-validate the Playbook: the CLI
carries the schema the Playbook is checked against, and a Playbook written
for a newer schema can carry fields an older CLI **silently drops rather
than flags** — validation comes back clean and the fields are gone. Then
the section below applies: the audit closes the upgrade.

## After a version change, verify — don't wait to be told

**Whenever you change the SDK version or the Playbook's schema version, run
`revturbine-verify-integration` before moving on.** Not if something looks
wrong: every time.

The reason is the failure mode. Almost nothing here throws — a mismatch
degrades instead of erroring, so an entitlement denies, a slot renders
nothing, a limit stops being enforced, and the app looks fine. "Run it if it
misbehaves" never fires when the symptom is silence, and an upgrade is
exactly when a silent mismatch gets introduced. The audit is read-only and
changes nothing, so there is no cost to running it and a whole class of
defect that only it catches.

That covers a version bump in `package.json`, a `revturbine` CLI upgrade, a
Playbook re-exported from a newer schema, and the local-to-hosted provider
swap.

## Where to go next

- **Gate features and place monetization surfaces** —
  `revturbine-wire-monetization-surfaces`, which also fills in the real
  `uiPathResolvers` bodies.
- **Author a real Playbook** — `revturbine-author-playbook`.
- **Go live and make the Playbook changeable without a deploy** —
  `revturbine-release-lifecycle`.
- **After any version or schema change, and whenever something misbehaves** —
  `revturbine-verify-integration`. It also carries the conditions under which
  a problem is ours rather than yours, and should be reported to RevTurbine
  instead of worked around.

## If you get stuck

Command syntax comes from `revturbine <command> --help`, never from memory;
field shapes from `revturbine schema`. For anything else, follow
`revturbine-start-here` → If you get stuck.
