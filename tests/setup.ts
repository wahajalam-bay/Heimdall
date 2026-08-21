import { beforeAll } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Tests run against a real database — the same SQLite file the application uses —
 * because the rules being tested live in the database layer as much as in code.
 * The suite is read-mostly and creates its own records with distinct numbering,
 * so it does not disturb the seeded demonstration data.
 */
beforeAll(async () => {
  const entities = await prisma.entity.count();
  if (entities === 0) {
    throw new Error(
      "The database is empty. Run `npm run db:reset` before the test suite so the seeded organisation exists.",
    );
  }
});

/** Fails a test with a clear message when a fixture the test depends on is absent. */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Fixture missing: ${what}. Re-run \`npm run db:reset\` to restore the seeded data.`);
  }
  return value;
}
