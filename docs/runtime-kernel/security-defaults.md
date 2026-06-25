# Runtime Kernel Security Defaults

Run402 Core binds published ports to localhost in the default Docker Compose file.

Default credentials are local-development credentials. Do not expose this stack directly to the internet.

## Included

- local Postgres roles for anon, authenticated, and service-role access
- RLS-compatible auth helpers backed by PostgREST JWT claims
- deterministic dev JWTs for repeatable local tests
- explicit unsupported-capability errors for excluded runtime features
- digest verification for staged static content
- digest and size verification for local storage uploads
- private storage objects hidden from anonymous callers as 404
- local signed-read URLs with bounded TTL
- immutable URL records resolved by content digest rather than mutable object rows
- static route manifests that fail closed for unsupported dynamic targets

## Not Included

- TLS automation
- high availability
- backup and restore automation
- production monitoring
- production secret management
- untrusted code sandboxing
- tenant isolation hardening beyond the local fixture path
- upgrade automation
- durable multi-node object storage
- managed object quotas, abuse automation, and backup/restore workflows

Treat this runtime as a portable developer reference until those operational concerns are designed and implemented.
