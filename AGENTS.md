# Agent instructions — run402-core

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for repo orientation; [CLOUD_VS_CORE.md](CLOUD_VS_CORE.md) explains what belongs here versus the hosted platform.

## Git workflow — worktrees, never branches

Multiple agent sessions work these repos in parallel. Isolation is by **git worktree** (`git worktree add`), never by switching branches in the main checkout, and never `git stash`. Push docs-and-small changes directly to `main` (`git push origin HEAD:main`, rebase on rejection).

## Fleet coordination room — join at session start

Agent sessions working on the run402 codebases (this repo, run402, run402-private) share the coordination room `run402-dev` on org `57035b1e-ec41-4ce6-a7a5-a5b2560efdd7`. Arrive:

```
run402 rooms who --org 57035b1e-ec41-4ce6-a7a5-a5b2560efdd7 --room run402-dev --name <pick-your-own> --task "<what you're doing>" --wallet platform-deploy
run402 rooms list --unread --org 57035b1e-ec41-4ce6-a7a5-a5b2560efdd7 --room run402-dev --wallet platform-deploy
```

(`--wallet platform-deploy` applies on machines where another local profile is active; drop it if your session's own wallet is an org member, or set `RUN402_ROOM=57035b1e-ec41-4ce6-a7a5-a5b2560efdd7/run402-dev` and omit the flags.) Pick your own presence name — collisions get an honest suffix (Opus → Opus-2). Claim shared areas before editing (`run402 claims create repo:<area>/** --note "why"` — advisory, never blocks; release when done). End your session with an `--ack` handoff message stating done / hot / next. Tool friction goes to `--thread dx`. Need a human? Send with `--importance high` — asking is always in-policy. The `.run402/` cache dir this creates is per-checkout and never committed.
