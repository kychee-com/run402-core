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
