import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ROUTE_DISCOVERY_MAX_BYTES,
  ReleaseSpecValidationError,
  computeReleaseDiff,
  computeRouteManifestSha256,
  materializeRelease,
  materializeRoutes,
  parseReleaseSpec,
} from "./index.js";
import type { RouteSpec } from "./types.js";

const discovery = {
  description: "Agent-likeness score, sybil funder flags, and chain facts for an address.",
  mime_type: "application/json",
  service_name: "FlapJax Checker",
  tags: ["wallets", "sybil"],
  icon_url: "https://flapjax-check.run402.com/icon.png",
  input: {
    query_params_schema: { type: "object", required: ["address"], properties: { address: { type: "string" } } },
    example: { address: "0x0000000000000000000000000000000000000000" },
  },
  output: { example: { score: 0.82 }, schema: { type: "object" } },
};

function route(overrides: Partial<RouteSpec> = {}, discoveryOverride: unknown = discovery): RouteSpec {
  return {
    pattern: "/check",
    methods: ["GET"],
    target: { type: "function", name: "api" },
    pricing: {
      mode: "always",
      amount_usd_micros: 20_000,
      pay_to: "org_default_payout",
      discovery: discoveryOverride as never,
    },
    ...overrides,
  };
}

function refusedAt(fn: () => unknown, resource: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ReleaseSpecValidationError, String(error));
    assert.equal(error.resource, resource);
    return true;
  });
}

/** Both validation doors (ReleaseSpec validation and route materialization) refuse at the same path. */
function refusedOnBothPaths(spec: RouteSpec, suffix: string): void {
  refusedAt(() => materializeRoutes([spec]), `routes.replace.0.${suffix}`);
  refusedAt(() => parseReleaseSpec({ project: "prj_1", routes: { replace: [spec] } }), `routes.replace.0.${suffix}`);
}

describe("route pricing discovery", () => {
  it("accepts a query-parameter GET route and keeps the declaration", () => {
    const materialized = materializeRoutes([route()]);
    assert.deepEqual(materialized.entries[0]?.pricing?.discovery, discovery);
    parseReleaseSpec({ project: "prj_1", routes: { replace: [route()] } });
  });

  it("accepts a description-only declaration", () => {
    const materialized = materializeRoutes([route({}, { description: "Echo" })]);
    assert.deepEqual(materialized.entries[0]?.pricing?.discovery, { description: "Echo" });
  });

  it("accepts a body declaration on a POST route", () => {
    const body = { description: "Score a batch", input: { body_type: "json", body_schema: { type: "object" }, example: { addresses: [] } } };
    const materialized = materializeRoutes([route({ methods: ["POST"] }, body)]);
    assert.deepEqual(materialized.entries[0]?.pricing?.discovery, body);
  });

  it("accepts GET with HEAD as one discoverable method", () => {
    materializeRoutes([route({ methods: ["GET", "HEAD"] })]);
  });

  it("is absent from routes that do not declare it", () => {
    const plain = route();
    delete (plain.pricing as { discovery?: unknown }).discovery;
    const materialized = materializeRoutes([plain]);
    assert.equal(materialized.entries[0]?.pricing && "discovery" in materialized.entries[0].pricing, false);
  });

  it("participates in the manifest digest independent of key order", () => {
    const reordered = {
      output: { schema: { type: "object" }, example: { score: 0.82 } },
      input: {
        example: { address: "0x0000000000000000000000000000000000000000" },
        query_params_schema: { properties: { address: { type: "string" } }, required: ["address"], type: "object" },
      },
      icon_url: discovery.icon_url,
      tags: discovery.tags,
      service_name: discovery.service_name,
      mime_type: discovery.mime_type,
      description: discovery.description,
    };
    const a = computeRouteManifestSha256(materializeRoutes([route()]).entries);
    const b = computeRouteManifestSha256(materializeRoutes([route({}, reordered)]).entries);
    const c = computeRouteManifestSha256(materializeRoutes([route({}, { ...discovery, description: "Different" })]).entries);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("refuses a missing or oversized description", () => {
    refusedOnBothPaths(route({}, { mime_type: "application/json" }), "pricing.discovery.description");
    refusedOnBothPaths(route({}, { description: "x".repeat(501) }), "pricing.discovery.description");
    materializeRoutes([route({}, { description: "x".repeat(500) })]);
  });

  it("refuses unknown keys", () => {
    refusedOnBothPaths(route({}, { ...discovery, serviceName: "camel" }), "pricing.discovery.serviceName");
  });

  it("refuses a fifth tenant tag, non-ASCII tags, and duplicates", () => {
    refusedOnBothPaths(route({}, { ...discovery, tags: ["a", "b", "c", "d", "e"] }), "pricing.discovery.tags");
    refusedOnBothPaths(route({}, { ...discovery, tags: ["café"] }), "pricing.discovery.tags.0");
    refusedOnBothPaths(route({}, { ...discovery, tags: ["a", "a"] }), "pricing.discovery.tags.1");
  });

  it("refuses an invalid service_name", () => {
    refusedOnBothPaths(route({}, { ...discovery, service_name: "x".repeat(33) }), "pricing.discovery.service_name");
  });

  it("refuses an icon_url that is not a public https URL", () => {
    for (const icon_url of ["http://example.com/i.png", "https://127.0.0.1/i.png", "https://user:pw@example.com/i.png", "https://localhost/i.png"]) {
      refusedOnBothPaths(route({}, { ...discovery, icon_url }), "pricing.discovery.icon_url");
    }
  });

  it("refuses external schema references", () => {
    refusedOnBothPaths(
      route({}, { ...discovery, output: { schema: { $ref: "https://example.com/schema.json" } } }),
      "pricing.discovery.output.schema.$ref",
    );
    materializeRoutes([route({}, { ...discovery, output: { schema: { $ref: "#/definitions/x", definitions: { x: {} } } } })]);
  });

  it("refuses the wrong input shape for the route's method", () => {
    refusedOnBothPaths(route({}, { description: "d", input: { body_type: "json" } }), "pricing.discovery.input");
    refusedOnBothPaths(route({ methods: ["POST"] }, { description: "d", input: { query_params_schema: {} } }), "pricing.discovery.input.query_params_schema");
    refusedOnBothPaths(route({ methods: ["POST"] }, { description: "d", input: {} }), "pricing.discovery.input.body_type");
  });

  it("refuses a declaration over the size cap", () => {
    const big = { description: "d", output: { example: { blob: "x".repeat(ROUTE_DISCOVERY_MAX_BYTES) } } };
    refusedOnBothPaths(route({}, big), "pricing.discovery");
  });

  it("refuses multi-method, any-method, and prefix routes", () => {
    refusedOnBothPaths(route({ methods: ["GET", "POST"] }), "methods");
    const anyMethod = route();
    delete anyMethod.methods;
    refusedOnBothPaths(anyMethod, "methods");
    refusedOnBothPaths(route({ pattern: "/api/*" }), "pricing.discovery");
  });
});

describe("route pricing discovery in plan diffs", () => {
  const SHA = "a".repeat(64);
  function release(routeSpec: RouteSpec, concreteBase?: ReturnType<typeof materializeRelease>) {
    return materializeRelease({
      ...(concreteBase ? { concreteBase } : {}),
      spec: {
        project: "p0001",
        functions: { replace: { api: { runtime: "node22", source: { sha256: SHA, size: 10 } } } },
        routes: { replace: [routeSpec] },
      },
    });
  }

  it("reports a discovery-only edit as a pricing change", () => {
    const from = release(route());
    const to = release(route({}, { ...discovery, description: "Updated" }), from);
    const diff = computeReleaseDiff(from, to);
    assert.deepEqual(diff.routes.changed.map((change) => change.fields_changed), [["pricing"]]);
  });

  it("reports nothing for an identical re-apply", () => {
    const from = release(route());
    const to = release(route(), from);
    assert.deepEqual(computeReleaseDiff(from, to).routes.changed, []);
  });
});
