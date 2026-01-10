// MIGRATION RUNNER -------------------------------------------------------------
// Purpose: apply SQL migrations in a controlled, idempotent way.
// Why: a growing system needs deterministic schema evolution; relying on dumps and ad-hoc ALTERs does not scale operationally.

import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// PATHS ------------------------------------------------------------------------
const BACKEND_ROOT = path.resolve(process.cwd());
const MIGRATIONS_DIR = path.resolve(BACKEND_ROOT, 'migrations');

// DB CONFIG --------------------------------------------------------------------
// Notes: multipleStatements is enabled ONLY here because migrations are trusted local files.
const dbConfig = {
	host: process.env.HOST,
	port: Number(process.env.DB_PORT || 3306),
	user: process.env.DB_USER,
	password: process.env.DB_PASS,
	database: process.env.DB_NAME,
	multipleStatements: true,
	charset: 'utf8mb4',
};

// FILENAME ORDERING ------------------------------------------------------------
// Steps: stable sort by filename so chronological prefixes work.
function sortMigrationFilenames(migrationFilenames: string[]): string[] {
	return [...migrationFilenames].sort((left, right) => left.localeCompare(right));
}

// READ MIGRATION FILES ---------------------------------------------------------
// Steps: list *.sql, sort deterministically, then return absolute paths.
async function listMigrationFiles(): Promise<{ filename: string; fullPath: string }[]> {
	const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
	const sqlFiles = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.sql')).map(entry => entry.name);
	return sortMigrationFilenames(sqlFiles).map(filename => ({ filename, fullPath: path.join(MIGRATIONS_DIR, filename) }));
}

// ENSURE MIGRATION TABLE -------------------------------------------------------
// Steps: create `schema_migrations` if missing so we can track applied files.
async function ensureSchemaMigrationsTable(connection: mysql.Connection): Promise<void> {
	await connection.execute(/*sql*/ `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id INT NOT NULL AUTO_INCREMENT,
			filename VARCHAR(255) NOT NULL,
			applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (id),
			UNIQUE KEY uniq_schema_migrations_filename (filename)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
	`);
}

// READ APPLIED SET -------------------------------------------------------------
// Steps: load applied filenames into a Set so we can skip already-applied migrations.
async function readAppliedMigrationFilenames(connection: mysql.Connection): Promise<Set<string>> {
	const [rows] = await connection.execute(/*sql*/ `SELECT filename FROM schema_migrations ORDER BY id ASC`);
	const applied = new Set<string>();
	for (const row of rows as any[]) row?.filename && applied.add(String(row.filename));
	return applied;
}

// APPLY ONE MIGRATION ----------------------------------------------------------
// Steps: read file, run it in a transaction boundary owned by the file, then record it (idempotent via UNIQUE).
async function applyOneMigrationFile(connection: mysql.Connection, filename: string, fullPath: string): Promise<void> {
	const sql = await fs.readFile(fullPath, 'utf8');
	await connection.query(sql);
	await connection.execute(/*sql*/ `INSERT IGNORE INTO schema_migrations (filename) VALUES (?)`, [filename]);
}

// MAIN -------------------------------------------------------------------------
// Steps: connect, ensure tracking table, compute pending files, apply sequentially, exit non-zero on error.
async function applyMigrations(): Promise<void> {
	const connection = await mysql.createConnection(dbConfig);
	try {
		await ensureSchemaMigrationsTable(connection);
		const applied = await readAppliedMigrationFilenames(connection);
		const migrationFiles = await listMigrationFiles();
		const pending = migrationFiles.filter(file => !applied.has(file.filename));

		if (!pending.length) {
			console.log('No pending migrations.');
			return;
		}

		for (const file of pending) {
			console.log(`Applying: ${file.filename}`);
			await applyOneMigrationFile(connection, file.filename, file.fullPath);
		}

		console.log(`Applied ${pending.length} migration(s).`);
	} finally {
		await connection.end();
	}
}

applyMigrations().catch(error => {
	// FATAL ----------------------------------------------------------------------
	// Steps: print error and force non-zero exit code so CI/ops can detect failure.
	console.error('Migration failed:', error?.message || error);
	process.exit(1);
});





