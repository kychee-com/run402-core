# Agent instructions — run402-core

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for repo orientation; [CLOUD_VS_CORE.md](CLOUD_VS_CORE.md) explains what belongs here versus the hosted platform.

## Git workflow — worktrees, never branches

Multiple agent sessions work these repos in parallel. Isolation is by **git worktree** (`git worktree add`), never by switching branches in the main checkout, and never `git stash`. Push docs-and-small changes directly to `main` (`git push origin HEAD:main`, rebase on rejection).

## Fleet coordination room — join at session start

Agent sessions working on the run402 codebases (this repo, run402, run402-private) share the coordination room `run402-dev` on org `57035b1e-ec41-4ce6-a7a5-a5b2560efdd7`. Export only the room address; scope the coordination wallet to each room command:

```
export RUN402_ROOM=57035b1e-ec41-4ce6-a7a5-a5b2560efdd7/run402-dev
run402 --wallet platform-deploy rooms join --name <pick-your-own> --task "<what you're doing>"
run402 --wallet platform-deploy messages list --unread
```

Use `--wallet platform-deploy` only on coordination commands. Pick your own presence name — collisions get an honest suffix (Opus → Opus-2). Claim shared areas before editing (`run402 claims create repo:<area>/** --note "why"` — advisory, never blocks; release when done). End with a done / hot / next handoff. Use `--ack --to <observed participant>` only when a known recipient is available; otherwise broadcast without `--ack`. Tool friction goes to `--thread dx`. Need a human? Send with `--importance high` — asking is always in-policy. The `.run402/` cache dir this creates is per-checkout and never committed.

**Skills announce shared-state work.** `/publish-core` reports the published version and whether the gateway pin is done — npm is irreversible and the private repo's pickup is a second step someone may be waiting on. Best-effort (`|| true`), so a wedged room can never fail a publish. Reading and thinking skills are deliberately not wired: announcing them is the noise that makes agents stop reading the room.

### Coordination identity is not deployment authority

**Cloud sessions (Claude Code on the web).** The container starts with no wallet. `.claude/hooks/session-start.sh` imports `RUN402_FLEET_WALLET_KEY` from the cloud environment's settings as the `platform-deploy` profile and exports `RUN402_ROOM`, so the commands above work unchanged. That cloud wallet (`0x5277AAA19F8af3216BC5345014C731E5aA68628F`) is a dedicated developer member of the fleet org, not a human's key: coordination only, never funded, never a deployment wallet. If the hook reports the key unset, room commands fail `WALLET_NOT_FOUND`; say so in your handoff rather than inventing a wallet.

The shared `platform-deploy` profile in the room instructions is for fleet coordination only. It is not authorization to build unrelated apps as that human principal. For a new independent demo, use the agent's own named wallet/profile and its free prototype setup, selected per command; preserve the global default. For existing authorized project work, use that project's intended credentials. Never copy a room wallet into deployment commands merely because it joined the room. Scope `--wallet platform-deploy` to room, message and claim commands, including skill announcements.
