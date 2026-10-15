import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required for database migrations.');
}

let sql: ReturnType<typeof postgres>;
try {
  sql = postgres(connectionString, {
    ssl: 'require',
    max: 3,
    connect_timeout: 10,
  });
} catch {
  throw new Error('DATABASE_URL is invalid. URL-encode special characters in its password.');
}

export default sql;