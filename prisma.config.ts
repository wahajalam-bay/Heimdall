import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * This replaces the deprecated `package.json#prisma` block. One consequence of
 * moving here is that the CLI no longer loads `.env` for us, so the datasource
 * URL has to be put on the environment before the config is handed back —
 * otherwise `prisma generate` and the seed lose their connection string.
 */
function loadEnvFile() {
  try {
    const raw = readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      // Values may be quoted; strip a single matching pair of quotes.
      const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
      // A real environment variable always wins over the file.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* No .env in this environment — the process environment must supply the URL. */
  }
}

loadEnvFile();

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
