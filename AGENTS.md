# AGENTS.md — revturbine-skills

Source of truth for the RevTurbine agent-skills catalog. Skills are consumed by
`npx skills` (vercel-labs), which reads `skills/<name>/SKILL.md`.

**Never create agent-specific instruction files** (`CLAUDE.md`, `.cursor/rules`).
`AGENTS.md` is the single source of truth for all AI tools in this repo.

## What these skills are

Customer-facing guidance that a builder's coding agent follows to integrate
RevTurbine into **their** app. Every skill body writes into someone else's
codebase (or tells the agent to), so accuracy and restraint matter more than
completeness.

## Authoring rules

1. **Canonical Playbook only.** RevTurbine config in any example is the canonical
   Playbook (`artifact_type: 'playbook'`, or the `revturbine.playbook.json` the
   scaffold drops). The legacy `{"version": "v1", ...}` wire shape is deprecated
   and MUST NOT appear in a skill — a skill is a worked example, and it teaches
   whatever shape it shows.
2. **Ground every API reference in the shipped SDK/CLI.** `@revturbine/sdk`
   exports `RevTurbineProvider`, `Gate`, `useEntitlement`, `usePlacement`,
   `Slot`; local mode is `localRuntime: { playbook }`; the CLI command is
   `revturbine` (`validate` / `launch` / `login` / `status`). Do not invent
   surface.
3. **Thread the guardrails inline.** Additive-only fallback; client check is a
   UX hint and revenue-critical entitlements are re-checked with `rtServer.can`;
   config flows through the Playbook, never direct DB writes; hosted is the
   destination; confirm irreversible (launch/promote/Stripe) with a human.
4. **Declare `safety_class` honestly** in frontmatter: `read-only-inspection`,
   `writes-app-code`, or `launches-live`. It calibrates how much an agent may do
   without asking.
5. **Namespace every skill `revturbine-*`** so it can't collide with a
   customer's own skills, and give it a **trigger-rich `description`** — the
   agent routes on that, not the body.
6. **Orchestrators route, never inline.** `revturbine-start-here` hands off to
   other skills by name; it does not copy their steps.

## Frontmatter shape

```yaml
---
name: revturbine-<kebab>
description: >
  Trigger-rich: what it does + when to use it + when to skip.
license: MIT
metadata:
  author: revturbine
  version: "0.1.0"
  safety_class: read-only-inspection | writes-app-code | launches-live
---
```

## Registry

`skills.sh.json` groups the catalog for discovery. Add each new skill to the
right grouping.

## Release gate

Run `npm ci && npm test && npm run check` before every change. The gate derives
the command and SDK inventories from the pinned public packages; do not commit
generated inventories or fixture applications. `npm run check:links` adds the
network-dependent URL sweep used by the nightly workflow.

Every new skill must be added to `skills.sh.json` and
`evals/trigger-fixtures.json`. If it writes testable output, also add its
mechanical assertions to `evals/outcome-contracts.json`. Outcome workspaces are
created under the operating system's temporary directory and are never tracked.
