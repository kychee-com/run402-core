// Compile-only: `npm run lint:functions` type-checks this file, and an unused @ts-expect-error fails it.
import type { AdminSqlResult, DbOptions } from "../src/db.js";
import { db, adminDb } from "../src/db.js";

declare const req: Request;

// db() takes a bare Request, an options bag, or nothing.
export const clients: unknown[] = [db(), db(req), db({ request: req }), db({ group: "2" }), db({ request: req, group: "2" })];

export const options: DbOptions[] = [{}, { request: req }, { group: "2" }];

// Both SQL clients answer the same envelope, so a call site moves by changing one identifier.
export async function envelopes(): Promise<[AdminSqlResult, AdminSqlResult]> {
  const asVisitor = await db().sql("SELECT 1", [1]);
  const asPlatform = await adminDb().sql("SELECT 1");
  const whom: { user_id: string } | null | undefined = asVisitor.actor;
  const role: "authenticated" | "anon" | undefined = asVisitor.role;
  void whom;
  void role;
  return [asVisitor, asPlatform];
}

export function refused(): void {
  // @ts-expect-error a group is a string, never a number
  void db({ group: 2 });
  // @ts-expect-error db() takes a Request or an options bag, not a string
  void db("2");
}
