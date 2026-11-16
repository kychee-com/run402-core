# Changelog

## Unreleased

- A function's MCP tools (`functions.*.tools[]`, `@run402/release`) are part of a plan's identity: the target release digest covers them, a change to tools alone is a new release and not a no-op, and an empty list is the same release as none. Core carries tools in its releases and serves no MCP endpoint.

- Consume the canonical Vite/Astro/hexadecimal static cache classifier from `@run402/release` 0.6.0; retained-public eligibility and one-hour deadlines are unchanged.

- Add the retained-static lookup port and public-entry eligibility contract. Core's Postgres activation adapters retain previously public non-HTML paths for one origin hour, with current routes/files taking precedence and no invented archive history. Add real HTTP conformance for public aliases, source identity, private-path denial and expiry.
