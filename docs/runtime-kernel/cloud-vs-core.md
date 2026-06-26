# Cloud Versus Core

Run402 Cloud should be the easiest place to start, not the only place the application can run.

Run402 Core exists to remove vendor-lock-in risk. It provides a public, self-hostable runtime boundary for the supported release slice.

Run402 Cloud can still remain proprietary where it operates managed infrastructure:

- multi-tenant allocation
- fleet scheduling
- Aurora operations
- global routing
- billing operations
- abuse controls
- backups
- monitoring
- compliance
- support

These are separate trust claims:

- Open source addresses portability and lock-in risk.
- Allowances and pricing controls address financial-risk exposure.

The current Core runtime is not operationally equivalent to Run402 Cloud. It is a Developer Preview single-node reference runtime for local and portable execution.

## Storage And Routing

Core now includes the portable storage/routing semantics for local development:

- local upload sessions through the Core gateway
- filesystem CAS plus Postgres object metadata
- public/private visibility behavior
- authenticated private reads and local signed reads
- immutable local object URLs
- explicit public paths and exact static aliases
- conformance fixtures that can be reused against Cloud for logical behavior checks

Cloud remains the managed production layer for global routing, edge caching, durable object operations, quotas and billing policy, backups, monitoring, abuse controls, compliance, and support. Core proves that application data-plane behavior can be inspected and run elsewhere; Cloud proves that the managed service operates it well.

## Functions Developer Preview

Core now exposes the public contract for trusted local Node functions. The first subset is deliberately narrow: pre-bundled `node22` source refs, no external npm dependencies, route-manifest function targets, direct invocation, local auth/role gates, local secrets, local logs/request-id diagnostics, typed fail-closed errors, and machine-readable resource/isolation defaults.

Core must not run project code inside the gateway/control-plane process. The supported local executor path is a Docker Compose project worker container. Until that worker is configured, function routes fail with `dynamic_runtime_unavailable`.

Cloud remains proprietary for Lambda/ECS/fleet execution, managed log operations, global routing, billing/quota/abuse controls, production secret custody, backups, monitoring, compliance, and support. Cloud may consume or verify public function semantics, but public Core must not expose Cloud provider identifiers or operational internals.

Open-source Core reduces lock-in risk because the supported application runtime slice can execute outside Run402 Cloud. Run402 Cloud allowance and spend controls reduce financial-risk exposure. These are separate trust claims.
