import "dotenv/config";

import { client, connectDB } from "../src/lib/db.js";
import { importSeed } from "../src/seed/index.js";
import { SeedValidationError } from "../src/seed/schema.js";
import type { ResourceResult, SeedImportSummary } from "../src/seed/applicator.js";

interface CliArgs {
  target: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // Support both `seed:import -- file.yml` and trailing `-- --dry-run` forms;
  // strip any standalone `--` separators that npm passes through.
  const args = argv.filter((arg) => arg !== "--");
  let dryRun = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error("Usage: npm run seed:import -- <file-or-directory> [--dry-run]");
  }

  return { target: positional[0], dryRun };
}

function countActions(results: ResourceResult[]): Record<string, number> {
  return results.reduce<Record<string, number>>((acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  }, {});
}

function formatLine(label: string, results: ResourceResult[]): string {
  const counts = countActions(results);
  const parts = Object.entries(counts).map(([action, n]) => `${n} ${action}`);
  return `  ${label.padEnd(14)} ${parts.length ? parts.join(", ") : "0"}`;
}

function printSummary(summary: SeedImportSummary): void {
  console.log("\n── Seed import summary" + (summary.dryRun ? " (dry-run)" : "") + " ──");
  console.log(formatLine("enterprises", summary.enterprises));
  console.log(formatLine("organizations", summary.organizations));
  console.log(formatLine("users", summary.users));
  console.log(formatLine("teams", summary.teams));
  console.log(formatLine("memberships", summary.memberships));
}

async function run(): Promise<void> {
  const { target, dryRun } = parseArgs(process.argv.slice(2));

  await connectDB();
  try {
    const summary = await importSeed(target, { dryRun });
    printSummary(summary);
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  if (err instanceof SeedValidationError) {
    console.error(`\n✗ ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
