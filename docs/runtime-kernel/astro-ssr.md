# Core Astro SSR Developer Preview

Run402 Core supports Astro SSR only through the first public `@run402/astro` output contract. This is a portability slice, not full Astro hosting and not Run402 Cloud production operations.

## Supported Contract

- output contract version: `astro.ssr.v1`
- `ReleaseSpec.functions.<name>.class: "ssr"`
- `ReleaseSpec.functions.<name>.capabilities` includes `astro.ssr.v1`
- runtime: pre-bundled Node 22 ESM source ref
- handler input: Web `Request`
- handler output: buffered Web `Response`
- fallback route: exactly one SSR target, internally exposed as `/*`
- static assets: served by the existing Core static route layer

Example function entry:

```json
{
  "runtime": "node22",
  "source": {
    "sha256": "<staged-content-digest>",
    "size": 1234,
    "contentType": "application/javascript"
  },
  "class": "ssr",
  "capabilities": ["astro.ssr.v1"]
}
```

## Route Precedence

Core resolves browser routes in this order:

1. explicit static aliases
2. public static asset paths
3. prerendered static HTML
4. dynamic function routes
5. Astro SSR fallback
6. 404

The public fixture in `fixtures/astro-ssr-core` verifies each collision case.

## Inherited Runtime Behavior

SSR uses the same dynamic runtime substrate as Core functions. SSR code does not run inside the gateway/control-plane process. It inherits the functions runtime defaults for trusted local code, explicit env allowlist, request body cap, response body cap, timeout, concurrency, stdout/stderr caps, local logs, request IDs, and required secrets.

Generated SSR responses include `X-Run402-Request-Id: req_...`. Logs are available through the functions logs endpoint with `request_id`, `function_name`, `since`, and `tail` filters.

## Unsupported In This Slice

Unsupported required behavior fails closed with `astro_ssr_unsupported_feature`, `unsupported_capability`, or an inherited dynamic-runtime error.

- full Astro support
- arbitrary Astro adapters
- streaming-to-client
- WebSockets and HTTP upgrade
- ISR/cache primitives
- edge runtime globals
- Cloud-only globals and routing hooks
- custom domains/global routing extraction
- Cloud export, Cloud import, and existing-project archive merge
- managed production operations such as fleet scheduling, billing, abuse controls, backups, monitoring, compliance, and support

Run402 Core reduces lock-in for the supported runtime slice. It supports local new-project import for portable archives, while Cloud export and Cloud import remain separate follow-up work.
