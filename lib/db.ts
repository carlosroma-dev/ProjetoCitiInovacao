import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  const certificate = process.env.DATABASE_CA_BASE64?.trim();
  pool = new Pool({
    connectionString,
    ssl: certificate ? { ca: Buffer.from(certificate, "base64").toString("utf8"), rejectUnauthorized: true } : undefined,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function one<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await getPool().query<T>(sql, params);
  return result.rows[0] ?? null;
}
