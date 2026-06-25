import { ReleaseFactProtocolError } from "./errors.js";
import { collectContentRefsFromSpec, deriveReleaseRequirements, type EffectRequirement } from "./diff.js";
import type { ContentRefHex, FactProtocolVersion, ReleaseSpec } from "./types.js";
import { FACT_PROTOCOL_VERSION } from "./versions.js";

export type FactRequirement =
  | {
      kind: "content";
      sha256: string;
      size: number;
      content_type?: string;
    }
  | {
      kind: "secret";
      key: string;
    }
  | {
      kind: "migration";
      migration_id: string;
      checksum_hex: string;
    };

export type FactState = "present" | "absent" | "unavailable";

export type ReleaseFact =
  | {
      kind: "content";
      sha256: string;
      state: FactState;
      size?: number;
      content_type?: string;
      reason?: string;
    }
  | {
      kind: "secret";
      key: string;
      state: FactState;
      reason?: string;
    }
  | {
      kind: "migration";
      migration_id: string;
      state: FactState;
      checksum_hex?: string;
      reason?: string;
    };

export interface ReleaseFactSet {
  fact_protocol_version: FactProtocolVersion;
  facts: ReleaseFact[];
}

export interface FactIssue {
  code:
    | "RUN402_CORE_CONTENT_MISSING"
    | "RUN402_CORE_SECRET_MISSING"
    | "RUN402_CORE_MIGRATION_CHECKSUM_MISMATCH";
  severity: "high";
  requirement: FactRequirement;
  message: string;
  details?: Record<string, unknown>;
}

export interface MigrationFactEvaluation {
  new: Array<{
    id: string;
    checksum_hex: string;
    transaction: "default" | "none";
  }>;
  noop: Array<{
    id: string;
    checksum_hex: string;
  }>;
  conflicts: Array<{
    id: string;
    expected_checksum_hex: string;
    observed_checksum_hex: string;
  }>;
}

export interface EvaluatedReleaseFacts {
  fact_protocol_version: FactProtocolVersion;
  requirements: FactRequirement[];
  effects: EffectRequirement[];
  issues: FactIssue[];
  migrations: MigrationFactEvaluation;
  ready: boolean;
}

const HEX_SHA_RE = /^[0-9a-f]{64}$/;

export function deriveFactRequirements(spec: ReleaseSpec): FactRequirement[] {
  const out: FactRequirement[] = [];
  for (const ref of collectContentRefsFromSpec(spec)) {
    out.push(contentRequirement(ref));
  }
  for (const key of spec.secrets?.require ?? []) {
    out.push({ kind: "secret", key });
  }
  for (const migration of spec.database?.migrations ?? []) {
    out.push({
      kind: "migration",
      migration_id: migration.id,
      checksum_hex: migration.checksum.toLowerCase(),
    });
  }
  return sortRequirements(dedupeRequirements(out));
}

export function emptyReleaseFactSet(): ReleaseFactSet {
  return {
    fact_protocol_version: FACT_PROTOCOL_VERSION,
    facts: [],
  };
}

export function validateReleaseFactSet(input: {
  requirements: FactRequirement[];
  factSet: ReleaseFactSet;
}): Map<string, ReleaseFact> {
  if (input.factSet.fact_protocol_version !== FACT_PROTOCOL_VERSION) {
    throw factError({
      code: "RUN402_CORE_FACT_UNSUPPORTED_VERSION",
      message: `unsupported fact protocol version: ${String(input.factSet.fact_protocol_version)}`,
      resource: "fact_protocol_version",
      details: { supported: FACT_PROTOCOL_VERSION },
    });
  }
  if (!Array.isArray(input.factSet.facts)) {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "facts must be an array",
      resource: "facts",
    });
  }

  const required = new Map<string, FactRequirement>();
  for (const requirement of sortRequirements(input.requirements)) {
    const normalized = normalizeRequirement(requirement);
    required.set(factRequirementKey(normalized), normalized);
  }

  const facts = new Map<string, ReleaseFact>();
  for (let index = 0; index < input.factSet.facts.length; index++) {
    const fact = normalizeFact(input.factSet.facts[index], `facts.${index}`);
    const key = factObservationKey(fact);
    if (!required.has(key)) {
      throw factError({
        code: "RUN402_CORE_FACT_UNKNOWN",
        message: `fact does not satisfy any requirement: ${key}`,
        resource: `facts.${index}`,
        details: { fact_key: key },
      });
    }
    if (facts.has(key)) {
      throw factError({
        code: "RUN402_CORE_FACT_DUPLICATE",
        message: `duplicate fact for requirement: ${key}`,
        resource: `facts.${index}`,
        details: { fact_key: key },
      });
    }
    if (fact.state === "unavailable") {
      throw factError({
        code: "RUN402_CORE_FACT_UNAVAILABLE",
        message: `fact is unavailable: ${key}`,
        resource: `facts.${index}.state`,
        details: { fact_key: key, reason: fact.reason },
      });
    }
    facts.set(key, fact);
  }

  const missing = [...required.keys()].filter((key) => !facts.has(key));
  if (missing.length > 0) {
    throw factError({
      code: "RUN402_CORE_FACT_INCOMPLETE_SET",
      message: "fact set is missing required facts",
      resource: "facts",
      details: { missing },
    });
  }

  return facts;
}

export function evaluateReleaseFacts(input: {
  spec: ReleaseSpec;
  requirements?: FactRequirement[];
  factSet: ReleaseFactSet;
}): EvaluatedReleaseFacts {
  const requirements = sortRequirements(input.requirements ?? deriveFactRequirements(input.spec));
  const facts = validateReleaseFactSet({ requirements, factSet: input.factSet });
  const issues: FactIssue[] = [];
  const migrations: MigrationFactEvaluation = { new: [], noop: [], conflicts: [] };

  for (const requirement of requirements) {
    const fact = facts.get(factRequirementKey(requirement));
    if (!fact) continue;
    if (requirement.kind === "content") {
      if (fact.kind !== "content") continue;
      if (fact.state === "absent") {
        issues.push({
          code: "RUN402_CORE_CONTENT_MISSING",
          severity: "high",
          requirement,
          message: "Required content is absent.",
        });
      }
      continue;
    }
    if (requirement.kind === "secret") {
      if (fact.kind !== "secret") continue;
      if (fact.state === "absent") {
        issues.push({
          code: "RUN402_CORE_SECRET_MISSING",
          severity: "high",
          requirement,
          message: "Required secret key is absent.",
        });
      }
      continue;
    }
    if (fact.kind !== "migration") continue;
    if (fact.state === "absent") {
      migrations.new.push({
        id: requirement.migration_id,
        checksum_hex: requirement.checksum_hex,
        transaction: migrationTransaction(input.spec, requirement.migration_id),
      });
      continue;
    }
    const observed = fact.checksum_hex?.toLowerCase();
    if (observed === requirement.checksum_hex) {
      migrations.noop.push({
        id: requirement.migration_id,
        checksum_hex: requirement.checksum_hex,
      });
    } else {
      migrations.conflicts.push({
        id: requirement.migration_id,
        expected_checksum_hex: requirement.checksum_hex,
        observed_checksum_hex: observed ?? "",
      });
      issues.push({
        code: "RUN402_CORE_MIGRATION_CHECKSUM_MISMATCH",
        severity: "high",
        requirement,
        message: "Applied migration checksum does not match the requested migration.",
        details: { observed_checksum_hex: observed ?? "" },
      });
    }
  }

  migrations.new.sort((a, b) => compareAscii(a.id, b.id));
  migrations.noop.sort((a, b) => compareAscii(a.id, b.id));
  migrations.conflicts.sort((a, b) => compareAscii(a.id, b.id));
  issues.sort((a, b) => compareAscii(factRequirementKey(a.requirement), factRequirementKey(b.requirement)));

  return {
    fact_protocol_version: FACT_PROTOCOL_VERSION,
    requirements,
    effects: deriveReleaseRequirements({ spec: input.spec }),
    issues,
    migrations,
    ready: issues.length === 0,
  };
}

export function factRequirementKey(requirement: FactRequirement): string {
  switch (requirement.kind) {
    case "content":
      return `content:${requirement.sha256.toLowerCase()}`;
    case "secret":
      return `secret:${requirement.key}`;
    case "migration":
      return `migration:${requirement.migration_id}`;
  }
}

export function factObservationKey(fact: ReleaseFact): string {
  switch (fact.kind) {
    case "content":
      return `content:${fact.sha256.toLowerCase()}`;
    case "secret":
      return `secret:${fact.key}`;
    case "migration":
      return `migration:${fact.migration_id}`;
  }
}

function contentRequirement(ref: ContentRefHex): FactRequirement {
  return {
    kind: "content",
    sha256: ref.sha256.toLowerCase(),
    size: ref.size,
    ...(ref.contentType ? { content_type: ref.contentType } : {}),
  };
}

function normalizeRequirement(requirement: FactRequirement): FactRequirement {
  if (!requirement || typeof requirement !== "object") {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "fact requirement must be an object",
      resource: "requirements",
    });
  }
  if (requirement.kind === "content") {
    assertHexSha(requirement.sha256, "requirements.content.sha256");
    return {
      kind: "content",
      sha256: requirement.sha256.toLowerCase(),
      size: normalizeNonNegativeNumber(requirement.size, "requirements.content.size"),
      ...(requirement.content_type ? { content_type: requirement.content_type } : {}),
    };
  }
  if (requirement.kind === "secret") {
    if (typeof requirement.key !== "string" || requirement.key.length === 0) {
      throw factError({
        code: "RUN402_CORE_FACT_INVALID",
        message: "secret fact requirement key must be a non-empty string",
        resource: "requirements.secret.key",
      });
    }
    return { kind: "secret", key: requirement.key };
  }
  if (requirement.kind === "migration") {
    if (typeof requirement.migration_id !== "string" || requirement.migration_id.length === 0) {
      throw factError({
        code: "RUN402_CORE_FACT_INVALID",
        message: "migration fact requirement id must be a non-empty string",
        resource: "requirements.migration.migration_id",
      });
    }
    assertHexSha(requirement.checksum_hex, "requirements.migration.checksum_hex");
    return {
      kind: "migration",
      migration_id: requirement.migration_id,
      checksum_hex: requirement.checksum_hex.toLowerCase(),
    };
  }
  throw factError({
    code: "RUN402_CORE_FACT_INVALID",
    message: "unknown fact requirement kind",
    resource: "requirements.kind",
  });
}

function normalizeFact(fact: ReleaseFact, resource: string): ReleaseFact {
  if (!fact || typeof fact !== "object") {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "fact must be an object",
      resource,
    });
  }
  if (fact.state !== "present" && fact.state !== "absent" && fact.state !== "unavailable") {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "fact state must be present, absent, or unavailable",
      resource: `${resource}.state`,
    });
  }
  if (fact.kind === "content") {
    assertHexSha(fact.sha256, `${resource}.sha256`);
    return {
      kind: "content",
      sha256: fact.sha256.toLowerCase(),
      state: fact.state,
      ...(fact.size === undefined ? {} : { size: normalizeNonNegativeNumber(fact.size, `${resource}.size`) }),
      ...(fact.content_type ? { content_type: fact.content_type } : {}),
      ...(fact.reason ? { reason: fact.reason } : {}),
    };
  }
  if (fact.kind === "secret") {
    if (typeof fact.key !== "string" || fact.key.length === 0) {
      throw factError({
        code: "RUN402_CORE_FACT_INVALID",
        message: "secret fact key must be a non-empty string",
        resource: `${resource}.key`,
      });
    }
    return {
      kind: "secret",
      key: fact.key,
      state: fact.state,
      ...(fact.reason ? { reason: fact.reason } : {}),
    };
  }
  if (fact.kind === "migration") {
    if (typeof fact.migration_id !== "string" || fact.migration_id.length === 0) {
      throw factError({
        code: "RUN402_CORE_FACT_INVALID",
        message: "migration fact id must be a non-empty string",
        resource: `${resource}.migration_id`,
      });
    }
    if (fact.state === "present") {
      assertHexSha(fact.checksum_hex, `${resource}.checksum_hex`);
    }
    return {
      kind: "migration",
      migration_id: fact.migration_id,
      state: fact.state,
      ...(fact.checksum_hex ? { checksum_hex: fact.checksum_hex.toLowerCase() } : {}),
      ...(fact.reason ? { reason: fact.reason } : {}),
    };
  }
  throw factError({
    code: "RUN402_CORE_FACT_INVALID",
    message: "unknown fact kind",
    resource: `${resource}.kind`,
  });
}

function dedupeRequirements(requirements: FactRequirement[]): FactRequirement[] {
  const out = new Map<string, FactRequirement>();
  for (const requirement of requirements.map(normalizeRequirement)) {
    out.set(factRequirementKey(requirement), requirement);
  }
  return [...out.values()];
}

function sortRequirements(requirements: FactRequirement[]): FactRequirement[] {
  return requirements.map(normalizeRequirement).sort((a, b) =>
    compareAscii(factRequirementKey(a), factRequirementKey(b)),
  );
}

function migrationTransaction(spec: ReleaseSpec, migrationId: string): "default" | "none" {
  const migration = spec.database?.migrations?.find((entry) => entry.id === migrationId);
  return migration?.transaction === "none" ? "none" : "default";
}

function normalizeNonNegativeNumber(value: unknown, resource: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "value must be a non-negative finite number",
      resource,
    });
  }
  return value;
}

function assertHexSha(value: unknown, resource: string): asserts value is string {
  if (typeof value !== "string" || !HEX_SHA_RE.test(value.toLowerCase())) {
    throw factError({
      code: "RUN402_CORE_FACT_INVALID",
      message: "value must be a lowercase 64-character hex sha256",
      resource,
    });
  }
}

function factError(input: {
  code:
    | "RUN402_CORE_FACT_UNSUPPORTED_VERSION"
    | "RUN402_CORE_FACT_INVALID"
    | "RUN402_CORE_FACT_DUPLICATE"
    | "RUN402_CORE_FACT_UNKNOWN"
    | "RUN402_CORE_FACT_INCOMPLETE_SET"
    | "RUN402_CORE_FACT_UNAVAILABLE";
  message: string;
  resource: string;
  details?: Record<string, unknown>;
}): ReleaseFactProtocolError {
  return new ReleaseFactProtocolError(input);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
