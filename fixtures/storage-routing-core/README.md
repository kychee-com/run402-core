# Storage Routing Core Fixture

This fixture is the canonical public Run402 Core app for Run402 Core storage and static routing conformance.

It exercises:

- explicit public path `/events` backed by `site/events.html`
- exact static alias route `/login` backed by `site/login.html`
- non-public release asset `site/hidden.txt`
- public object upload and anonymous read
- private object upload, anonymous denial, authenticated read, and signed read
- immutable object URL retention after mutable delete
- apply-time asset overwrite, delete, and sync-prune behavior

Run it against a local Core stack:

```bash
docker compose up -d --build core
npm run core:storage-routing
```

To include the restart-persistence check:

```bash
CORE_CONFORMANCE_RESTART=1 npm run core:storage-routing
```

Run402 Cloud uses managed production operations for global routing, durable object storage, quotas, backups, monitoring, abuse controls, compliance, and support. This fixture checks the portable logical behavior that Core and Cloud should share, not managed operations.
