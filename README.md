# RevTurbine Agent Skills

Installable [agent skills](https://skills.sh) that walk a coding agent through
integrating [RevTurbine](https://revturbine.com) — from an empty app to a
working monetization setup: SDK wired, Playbook authored, surfaces rendering,
verified end to end, with a marked path to billing and going live.

## Install

```bash
npx skills add revt-eng/revturbine-skills
```

`npm create revturbine` installs these for you and points the agent at
`revturbine-start-here`. You can also add any single skill:

```bash
npx skills add revt-eng/revturbine-skills --skill revturbine-integrate-sdk
```

## The catalog

| Skill | Does | Writes |
|---|---|---|
| **`revturbine-start-here`** | The front door — orientation, ground rules, and routing to every other skill (ships the shared `references/`) | nothing (routes) |
| **`revturbine-integrate-sdk`** | Install `@revturbine/sdk`, mount the provider, load the local Playbook, prove the closed loop | app code |
| **`revturbine-author-playbook`** | Create or edit the Playbook — plans, entitlements, rules, segments, trials, placements | Playbook file / staged draft |
| **`revturbine-monetization-best-practices`** | Packaging and pricing judgement for a first setup — what to gate, the ladder, the numbers, pacing | nothing (advisory) |
| **`revturbine-wire-monetization-surfaces`** | Wire slots and gates so authored placements render in the app | app code |
| **`revturbine-verify-integration`** | End-to-end audit when config looks right but the app behaves wrong | nothing (report) |
| **`revturbine-connect-billing`** | Connect Stripe so prices are real and purchases update the plan | billing mapping (human-confirmed) |
| **`revturbine-release-lifecycle`** | Connect the tenant, stage, preview, and launch to real users | live config (human-confirmed) |

This catalog supersedes the original six-skill seed set (retired 2026-08-19).
The ecosystem tool re-fetches on `skills update`.

## For skill authors

Skills are consumed by [`npx skills`](https://github.com/vercel-labs/skills):
each lives at `skills/<name>/SKILL.md` with a trigger-rich `description`. See
`AGENTS.md` for the authoring rules — especially that RevTurbine config in
examples is the **canonical Playbook**, never the deprecated legacy shape.

## Links

- [Docs](https://revturbine.com/docs) · [`@revturbine/sdk`](https://www.npmjs.com/package/@revturbine/sdk) · [`@revturbine/cli`](https://www.npmjs.com/package/@revturbine/cli)
