# RevTurbine Agent Skills

Installable [agent skills](https://skills.sh) that walk a coding agent through
integrating [RevTurbine](https://revturbine.com) — from an empty app to one paid
action gated, working locally, with a marked path to going live.

## Install

```bash
npx skills add revt-eng/revturbine-skills
```

`npm create revturbine` installs these for you and points the agent at
`revturbine-start-here`. You can also add any single skill:

```bash
npx skills add revt-eng/revturbine-skills --skill revturbine-add-gate
```

## The seed catalog

| Skill | Does | Writes |
|---|---|---|
| **`revturbine-start-here`** | The front door — sequences the whole first session and hands each step to its skill | nothing (routes) |
| **`revturbine-integration-best-practices`** | The rules every integration follows: additive-only, client-hint-not-authority, config-via-Playbook | nothing (reference) |
| **`revturbine-install-sdk-and-provider`** | Install `@revturbine/sdk`, mount `<RevTurbineProvider>`, identify the user | app code |
| **`revturbine-run-local-playbook`** | Point the provider at the local `revturbine.playbook.json` (`local_only` mode — no account, no network) | app code |
| **`revturbine-add-gate`** | Gate one paid action with `<Gate>`, with a server re-check for anything revenue-critical | app code |
| **`revturbine-go-live-hosted-cutover`** | Connect the tenant and swap local mode for the hosted control plane | live config (human-confirmed) |

This is the **seed** set. More skills — plans, segments, experiments, placements,
QA — are added over time; the ecosystem tool re-fetches them on `skills update`.

## For skill authors

Skills are consumed by [`npx skills`](https://github.com/vercel-labs/skills):
each lives at `skills/<name>/SKILL.md` with a trigger-rich `description`. See
`AGENTS.md` for the authoring rules — especially that RevTurbine config in
examples is the **canonical Playbook**, never the deprecated legacy shape.

## Links

- [Docs](https://revturbine.com/docs) · [`@revturbine/sdk`](https://www.npmjs.com/package/@revturbine/sdk) · [`@revturbine/cli`](https://www.npmjs.com/package/@revturbine/cli)
