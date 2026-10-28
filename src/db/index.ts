import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";

// Shared connection pool; reads the connection string from DATABASE_URL in .env
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: 5_000,
});
// On Vercel, keeps the function alive until idle connections close, so suspended instances don't
// leak them. Does nothing outside Vercel.
attachDatabasePool(pool);

// Drizzle instance used for all data access
export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
// Anything that can run queries: the root db or an open transaction
export type DbExecutor = Database | Transaction;

// Run work inside a single transaction; rolls back if the callback throws
export function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

// Read-only transaction on one snapshot, so several aggregate queries agree with each other
export function withReadSnapshot<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(fn, { isolationLevel: "repeatable read", accessMode: "read only" });
}

// Fail fast at startup if the database is unreachable
export async function connectDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("Connected to PostgreSQL");
  } finally {
    client.release();
  }
}
