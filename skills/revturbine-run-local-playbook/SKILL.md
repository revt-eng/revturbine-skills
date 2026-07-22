---
name: revturbine-run-local-playbook
description: >
  Point <RevTurbineProvider> at the local revturbine.playbook.json so
  entitlement and placement decisions resolve with no account and no network
  (local_only mode). Use right after the provider is mounted, when "RevTurbine
  isn't deciding anything locally", or when a gate always allows/denies because
  there is no config loaded. Writes app code — imports the Playbook and adds
  localRuntime to the provider options. Skip once localRuntime (or a hosted
  tenant) is already wired.
license: MIT
metadata:
  author: revturbine
  version: "0.1.0"
  safety_class: writes-app-code
---

# Run the local Playbook

Make RevTurbine actually decide, offline. `npm create revturbine` dropped a
`revturbine.playbook.json` — a canonical Playbook with a `free` and a `pro`
plan and one feature entitlement (`advanced_export`). This wires the provider to
it in **`local_only`** mode: real decisions, zero backend.

## 1. Import the Playbook and add `localRuntime`

Extend the provider options from `revturbine-install-sdk-and-provider`:

```tsx
import { RevTurbineProvider } from '@revturbine/sdk';
import { useMemo } from 'react';
import playbook from './revturbine.playbook.json';

const options = useMemo(() => ({
  localRuntime: { exportedConfig: playbook },
  user: {
    id: currentUser.id,
    context: { plan_handle: currentUser.planHandle ?? 'free' },
  },
  uiPathResolvers: {
    navigate_to_plans: () => { window.location.href = '/pricing'; },
  },
}), []);
```

`localRuntime.exportedConfig` is the whole switch — its presence puts the SDK in
`local_only` mode. No `tenantId`, `apiKey`, or `endpoint` is needed yet; those
come at go-live.

Adjust the import path to wherever the scaffold wrote the file (repo root by
default).

## 2. Confirm the config is valid before trusting it

If the CLI is pinned (it is, after `npm create revturbine`):

```bash
npx revturbine validate ./revturbine.playbook.json
```

Expect *"No validation findings."* If you hand-edited the Playbook and this
fails, fix the config rather than the app — the SDK will only ever be as correct
as the Playbook it loads.

## 3. Prove a decision resolves

`plan_handle: 'free'` should be **denied** `advanced_export`; `'pro'` should be
**allowed** it. A quick check with the hook:

```tsx
import { useEntitlement } from '@revturbine/sdk';

function DebugEntitlement() {
  const { allowed } = useEntitlement({ handle: 'advanced_export' });
  return <span>advanced_export: {allowed ? 'allowed' : 'denied'}</span>;
}
```

Flip the user's `plan_handle` between `free` and `pro` and watch it change. Once
that works, remove the debug component and move to `revturbine-add-gate` to gate
a real action.

## Keep it additive

Loading the Playbook must not change any existing behavior — nothing is gated
until you add a gate. If wiring `localRuntime` alters what renders, something is
gating by the provider's presence, which violates the additive-only rule.
