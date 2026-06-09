/**
 * YAML loading + parsing for seed documents.
 *
 * Supports a single `.yml`/`.yaml` file or a directory containing many of them.
 * Each parsed document is paired with its originating file path so downstream
 * merge/validation steps can produce helpful, location-aware error messages.
 *
 * DB/service free — safe to unit-test without a Mongo connection.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { validateSeedDocument } from "./schema.js";
import type { SeedDocument } from "./schema.js";

export interface LoadedSeedDocument {
  /** Absolute or caller-supplied path to the source file. */
  file: string;
  document: SeedDocument;
}

const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

function isYamlFile(filePath: string): boolean {
  return YAML_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Parse + structurally validate a single YAML file. */
async function loadFile(filePath: string): Promise<LoadedSeedDocument> {
  const contents = await readFile(filePath, "utf8");
  let raw: unknown;
  try {
    raw = parseYaml(contents);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML in ${filePath}: ${message}`);
  }
  // An empty file parses to `null`; treat it as an empty document.
  const document = validateSeedDocument(raw ?? {}, filePath);
  return { file: filePath, document };
}

/**
 * Load one seed file, or every `.yml`/`.yaml` file in a directory (sorted by
 * path for deterministic ordering).
 */
export async function loadSeedDocuments(target: string): Promise<LoadedSeedDocument[]> {
  const stats = await stat(target);

  if (stats.isFile()) {
    if (!isYamlFile(target)) {
      throw new Error(`Not a YAML file: ${target}`);
    }
    return [await loadFile(target)];
  }

  const entries = await readdir(target);
  const files = entries
    .map((entry) => path.join(target, entry))
    .filter(isYamlFile)
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No .yml/.yaml files found in directory: ${target}`);
  }

  const documents: LoadedSeedDocument[] = [];
  for (const file of files) {
    documents.push(await loadFile(file));
  }
  return documents;
}
