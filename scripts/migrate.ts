import { migrateDatabase } from "@drama/db/migrations";

async function main(): Promise<void> {
  try {
    const applied = await migrateDatabase();
    process.stdout.write(applied.length
      ? `Applied migrations: ${applied.join(", ")}\n`
      : "Database migrations are already current.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
