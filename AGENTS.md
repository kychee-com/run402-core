# Agent instructions — run402-core

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for repo orientation; [CLOUD_VS_CORE.md](CLOUD_VS_CORE.md) explains what belongs here versus the hosted platform.

## Where this code is edited

This repository is a published mirror: its `main` is generated from the `public/run402-core/` directory of Kychee's private platform monorepo and only ever fast-forwards. Maintainers and agents edit the code there, never in a clone of this repository.

- **Working inside the monorepo** (where this directory is `public/run402-core/`): follow the monorepo's root `AGENTS.md`. Make a worktree of the monorepo, never a worktree inside this directory; never `git stash`; never create local branches.
- **Contributing from outside:** open a pull request here as usual. A maintainer merges it on GitHub and pulls it back into the monorepo, and the next mirror run carries it forward.
- **Commit messages are public.** A change to this directory becomes this repository's history with its message unchanged, so keep messages free of private details.


## Fleet coordination room — join at session start

Agent sessions working on the run402 codebases (this repo, run402, run402-private) share the coordination room `run402-dev` on org `57035b1e-ec41-4ce6-a7a5-a5b2560efdd7`. Export only the room address; scope the coordination wallet to each room command:

```
export RUN402_ROOM=57035b1e-ec41-4ce6-a7a5-a5b2560efdd7/run402-dev
run402 --wallet platform-deploy rooms join --name <pick-your-own> --task "<what you're doing>"
run402 --wallet platform-deploy messages list --unread
```

Use `--wallet platform-deploy` only on coordination commands. Pick your own presence name — collisions get an honest suffix (Opus → Opus-2). Claim shared areas before editing (`run402 claims create repo:<area>/** --note "why"` — advisory, never blocks; release when done). End with a done / hot / next message. Use `--ack --to <observed participant>` only when a known recipient is available; otherwise broadcast without `--ack`. Tool friction goes to `--thread dx`. Need a human? Send with `--importance high` — asking is always in-policy. The `.run402/` cache dir this creates is per-checkout and never committed.

**Skills announce shared-state work.** `/publish-core` reports the published version and whether the gateway pin is done — npm is irreversible and the private repo's pickup is a second step someone may be waiting on. Best-effort (`|| true`), so a wedged room can never fail a publish. Reading and thinking skills are deliberately not wired: announcing them is the noise that makes agents stop reading the room.

### Coordination identity is not deploy authority

The shared `platform-deploy` profile in the room instructions is for fleet coordination only. It is not authorization to build unrelated apps as that human principal. For a new independent demo, use the agent's own named wallet/profile and its free prototype setup, selected per command; preserve the global default. For existing authorized project work, use that project's intended credentials. Never copy a room wallet into deploy commands merely because it joined the room. Scope `--wallet platform-deploy` to room, message and claim commands, including skill announcements.
