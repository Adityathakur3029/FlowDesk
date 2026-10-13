import "dotenv/config";
import { Pool } from "pg";

// Shared connection pool; reads the connection string from DATABASE_URL in .env
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
