# Astro SSR Core Fixture

This fixture models the first public `@run402/astro` server output contract.

- `functions/ssr.mjs` is the SSR target: Node ESM, Web `Request` input, Web `Response` output.
- `functions/api.mjs` is a regular function route that intentionally collides with the SSR fallback.
- `site/login.html`, `site/dashboard.html`, and `site/assets/app.txt` prove that static aliases, prerendered pages, and public assets win before SSR.

The conformance runner builds the `ReleaseSpec` dynamically so file digests come from the staged bytes.
