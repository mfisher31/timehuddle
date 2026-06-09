/**
 * Merge many loaded seed documents into a single import context.
 *
 * Keyed resources (enterprises, organizationTemplates, organizations, users,
 * teams) are merged by their stable seed key; a key that appears in more than
 * one file is reported as a conflict (with both source files). Memberships are
 * a list and are simply concatenated, preserving document + array order so that
 * imports are deterministic.
 *
 * DB/service free — safe to unit-test without a Mongo connection.
 */

import { KEYED_SECTIONS, SeedValidationError } from "./schema.js";
import type {
  EnterpriseSeed,
  MembershipSeed,
  OrganizationSeed,
  OrganizationTemplateSeed,
  SeedMetadata,
  TeamSeed,
  UserSeed,
} from "./schema.js";
import type { LoadedSeedDocument } from "./loader.js";

/** A resource paired with the file it came from. */
export interface SourcedResource<T> {
  key: string;
  file: string;
  value: T;
}

export interface SourcedMembership {
  index: number;
  file: string;
  value: MembershipSeed;
}

export interface ImportContext {
  metadata: SeedMetadata;
  enterprises: Map<string, SourcedResource<EnterpriseSeed>>;
  organizationTemplates: Map<string, SourcedResource<OrganizationTemplateSeed>>;
  organizations: Map<string, SourcedResource<OrganizationSeed>>;
  users: Map<string, SourcedResource<UserSeed>>;
  teams: Map<string, SourcedResource<TeamSeed>>;
  memberships: SourcedMembership[];
}

type KeyedSection = (typeof KEYED_SECTIONS)[number];

function mergeKeyedSection<T>(
  section: KeyedSection,
  documents: LoadedSeedDocument[],
  target: Map<string, SourcedResource<T>>,
  issues: string[]
): void {
  for (const { file, document } of documents) {
    const resources = document[section] as Record<string, T> | undefined;
    if (!resources) continue;
    for (const [key, value] of Object.entries(resources)) {
      const existing = target.get(key);
      if (existing) {
        issues.push(
          `Duplicate ${section} key "${key}" defined in both ${existing.file} and ${file}`
        );
        continue;
      }
      target.set(key, { key, file, value });
    }
  }
}

/**
 * Merge loaded documents into one {@link ImportContext}. Throws a
 * {@link SeedValidationError} if the same keyed resource is declared twice.
 */
export function mergeSeedDocuments(documents: LoadedSeedDocument[]): ImportContext {
  const issues: string[] = [];

  const context: ImportContext = {
    metadata: {},
    enterprises: new Map(),
    organizationTemplates: new Map(),
    organizations: new Map(),
    users: new Map(),
    teams: new Map(),
    memberships: [],
  };

  // Last non-empty metadata wins; merge field-by-field so a name in one file and
  // a description in another both survive.
  for (const { document } of documents) {
    if (document.metadata) {
      context.metadata = { ...context.metadata, ...document.metadata };
    }
  }

  mergeKeyedSection("enterprises", documents, context.enterprises, issues);
  mergeKeyedSection("organizationTemplates", documents, context.organizationTemplates, issues);
  mergeKeyedSection("organizations", documents, context.organizations, issues);
  mergeKeyedSection("users", documents, context.users, issues);
  mergeKeyedSection("teams", documents, context.teams, issues);

  for (const { file, document } of documents) {
    document.memberships?.forEach((value, index) => {
      context.memberships.push({ index, file, value });
    });
  }

  if (issues.length > 0) throw new SeedValidationError(issues);

  return context;
}
