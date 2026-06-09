/**
 * Seed import orchestration.
 *
 * Ties the pipeline together: load → (structural validation happens during
 * load) → merge → resolve references → apply. Importing a single file or a
 * directory of files both flow through the same merged import context, so
 * references resolve across files.
 */

export * from "./schema.js";
export * from "./loader.js";
export * from "./merge.js";
export * from "./resolver.js";
export * from "./applicator.js";

import { loadSeedDocuments } from "./loader.js";
import { mergeSeedDocuments } from "./merge.js";
import { resolveReferences } from "./resolver.js";
import { applySeed } from "./applicator.js";
import type { ResolvedContext } from "./resolver.js";
import type { ApplyOptions, SeedImportSummary } from "./applicator.js";

/** Load, validate, merge, and resolve a seed target without writing anything. */
export async function planSeedImport(target: string): Promise<ResolvedContext> {
  const documents = await loadSeedDocuments(target);
  const context = mergeSeedDocuments(documents);
  return resolveReferences(context);
}

/** Run the full seed import pipeline against a file or directory. */
export async function importSeed(
  target: string,
  options: ApplyOptions = {}
): Promise<SeedImportSummary> {
  const resolved = await planSeedImport(target);
  return applySeed(resolved, options);
}
