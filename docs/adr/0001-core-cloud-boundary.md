# ADR 0001: Core And Cloud Boundary

## Status

Accepted

## Context

Run402 needs a public runtime source boundary that reduces vendor-lock-in risk without forcing all managed Cloud operations into the open-source repository at once.

## Decision

Create `run402-core` as the Apache 2.0 home for production-used server/runtime code that is safe to publish. Keep Cloud operations private when they involve production fleet management, billing operations, abuse controls, backups, monitoring, compliance, or support.

Run402 Cloud consumes public Core artifacts instead of maintaining private behavioral forks.

## Consequences

- Core code becomes public incrementally.
- Cloud remains commercially valuable because it operates infrastructure well.
- Public docs and tests substitute for private OpenSpec artifacts.
- Every extraction must prove direct Cloud consumption, not just compatibility.
