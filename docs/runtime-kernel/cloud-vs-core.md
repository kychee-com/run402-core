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
