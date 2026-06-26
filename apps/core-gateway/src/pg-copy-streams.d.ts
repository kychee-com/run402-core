declare module "pg-copy-streams" {
  import type { Duplex } from "node:stream";

  export function from(sql: string): Duplex;
  export function to(sql: string): Duplex;
  export function both(sql: string): Duplex;
}
