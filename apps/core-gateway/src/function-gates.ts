import type { Pool as PgPool } from "pg";
import type { RoleGateSpec } from "@run402/release";

export interface FunctionRoleGatePort {
  resolveRole(input: {
    projectSchema: string;
    actorId: string;
    gate: RoleGateSpec;
  }): Promise<string | null>;
}

export class PostgresFunctionRoleGateStore implements FunctionRoleGatePort {
  readonly #pool: PgPool;

  constructor(pool: PgPool) {
    this.#pool = pool;
  }

  async resolveRole(input: {
    projectSchema: string;
    actorId: string;
    gate: RoleGateSpec;
  }): Promise<string | null> {
    assertSafeIdentifier(input.projectSchema, "project_schema");
    assertSafeIdentifier(input.gate.table, "requireRole.table");
    assertSafeIdentifier(input.gate.idColumn, "requireRole.idColumn");
    assertSafeIdentifier(input.gate.roleColumn, "requireRole.roleColumn");
    const result = await this.#pool.query<{ role: unknown }>(
      `SELECT ${quoteIdent(input.gate.roleColumn)} AS role
         FROM ${quoteIdent(input.projectSchema)}.${quoteIdent(input.gate.table)}
        WHERE ${quoteIdent(input.gate.idColumn)} = $1
        LIMIT 1`,
      [input.actorId],
    );
    const role = result.rows[0]?.role;
    return typeof role === "string" ? role : null;
  }
}

export function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function assertSafeIdentifier(value: string, name: string): void {
  if (!isSafeIdentifier(value)) {
    throw new RangeError(`${name} must be an unquoted SQL identifier.`);
  }
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
