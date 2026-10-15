# Agent instructions — run402-core

Start with [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for repo orientation; [CLOUD_VS_CORE.md](CLOUD_VS_CORE.md) explains what belongs here versus the hosted platform.

## Where this code is edited

This repository is a published mirror: its `main` is generated from the `public/run402-core/` directory of Kychee's private platform monorepo and only ever fast-forwards. Maintainers and agents edit the code there, never in a clone of this repository.

- **Working inside the monorepo** (where this directory is `public/run402-core/`): follow the monorepo's root `AGENTS.md`. Make a worktree of the monorepo, never a worktree inside this directory; never `git stash`; never create local branches.
- **Contributing from outside:** open a pull request here as usual. A maintainer merges it on GitHub and pulls it back into the monorepo, and the next mirror run carries it forward.
- **Commit messages are public.** A change to this directory becomes this repository's history with its message unchanged, so keep messages free of private details.
