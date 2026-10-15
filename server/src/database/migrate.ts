import sql from './db.js';

const migrations = [
  '20261010_project_rag.sql',
  '20261015_index_tree_rag.sql',
  '20261016_project_index_tree.sql',
].map((fileName) => new URL(`../../migrations/${fileName}`, import.meta.url));

try {
  for (const migration of migrations) await sql.file(migration);
  console.log('Supabase migrations applied successfully.');
} finally {
  await sql.end({ timeout: 5 });
}