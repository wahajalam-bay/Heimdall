/**
 * Runs every verification script in turn and reports the whole picture.
 *
 *   npx tsx scripts/verify-all.ts
 *   npx tsx scripts/verify-all.ts --sweep    # clear debris from killed runs first
 *
 * `verify-journeys.ts` is excluded: it drives the application over HTTP and
 * needs a dev server, so a failure there says nothing about the domain.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { sweepTestDebris } from "./lib/fixtures";

const HTTP_ONLY = new Set(["verify-journeys.ts", "verify-all.ts"]);

async function main() {
  if (process.argv.includes("--sweep")) {
    const removed = await sweepTestDebris();
    const total = Object.values(removed).reduce((a, n) => a + n, 0);
    console.log(
      total
        ? `Swept ${total} leftover row(s): ${Object.entries(removed).map(([k, n]) => `${n} ${k}`).join(", ")}\n`
        : "No leftover test data.\n",
    );
  }
  await prisma.$disconnect();

  const scripts = readdirSync("scripts")
    .filter((f) => f.startsWith("verify-") && f.endsWith(".ts") && !HTTP_ONLY.has(f))
    .sort();

  const results: Array<{ script: string; ok: boolean; summary: string }> = [];

  for (const script of scripts) {
    process.stdout.write(`\n── ${script} ${"─".repeat(Math.max(0, 56 - script.length))}\n`);
    const run = spawnSync("npx", ["tsx", `scripts/${script}`], {
      encoding: "utf8",
      shell: true,
    });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const summary =
      out.match(/(\d+) passed, (\d+) failed/)?.[0] ??
      out.match(/(\d+)\/(\d+) checks passed[^\n]*/)?.[0] ??
      (run.status === 0 ? "passed" : "no summary line");
    const ok = run.status === 0;
    results.push({ script, ok, summary });
    console.log(`  ${ok ? "OK  " : "FAIL"} ${summary}`);
    if (!ok) {
      // Show the failing lines rather than the whole transcript.
      const bad = out.split("\n").filter((l) => l.includes("FAIL") || l.includes("Error"));
      for (const l of bad.slice(0, 12)) console.log(`       ${l.trim()}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"═".repeat(64)}`);
  for (const r of results) {
    console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.script.padEnd(34)} ${r.summary}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} verification scripts passed.` +
      (failed.length ? ` Failed: ${failed.map((f) => f.script).join(", ")}` : ""),
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
