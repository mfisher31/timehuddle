/**
 * Seed YAML schema + structural (Phase 1) validation.
 *
 * The seed format is Docker-Compose-inspired: a single YAML document may declare
 * multiple resource sections (`enterprises`, `organizationTemplates`,
 * `organizations`, `users`, `teams`, `memberships`). Each map key is the stable
 * seed key used to cross-reference resources between files.
 *
 * This module is intentionally free of any database/service imports so it can be
 * unit-tested without a Mongo connection.
 */

import { ORG_MEMBERSHIP_ROLES } from "../models/org-membership.model.js";
import type { OrgMembershipRole } from "../models/org-membership.model.js";

export const SEED_VERSION = 1;

/** Sections that may appear at the top level of a seed document. */
export const TOP_LEVEL_SECTIONS = [
  "version",
  "metadata",
  "enterprises",
  "organizationTemplates",
  "organizations",
  "users",
  "teams",
  "memberships",
] as const;

/** Resource sections that are keyed maps (`<key>: { ... }`). */
export const KEYED_SECTIONS = [
  "enterprises",
  "organizationTemplates",
  "organizations",
  "users",
  "teams",
] as const;

// Lowercase kebab-case / slug-style keys: "alice", "acme-main", "team-1".
const SEED_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Pragmatic email shape check — not a full RFC 5322 validator.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Seed resource types ────────────────────────────────────────────────────

export interface SeedMetadata {
  name?: string;
  description?: string;
}

export interface EnterpriseSeed {
  name: string;
  slug?: string;
}

export interface TemplateTeamSeed {
  name: string;
  description?: string;
}

export interface OrganizationTemplateSeed {
  name?: string;
  teams?: Record<string, TemplateTeamSeed>;
}

export interface OrganizationSeed {
  name: string;
  slug?: string;
  enterprise?: string;
  template?: string;
  allowAutoJoin?: boolean;
}

export interface UserSeed {
  name: string;
  email: string;
  /** Optional — a default is applied at import time when omitted. */
  password?: string;
  username?: string;
}

export interface TeamSeed {
  name: string;
  description?: string;
  organization: string;
  parentTeam?: string;
}

export interface MembershipSeed {
  user: string;
  organization: string;
  role?: OrgMembershipRole;
  teams?: string[];
}

export interface SeedDocument {
  version?: number;
  metadata?: SeedMetadata;
  enterprises?: Record<string, EnterpriseSeed>;
  organizationTemplates?: Record<string, OrganizationTemplateSeed>;
  organizations?: Record<string, OrganizationSeed>;
  users?: Record<string, UserSeed>;
  teams?: Record<string, TeamSeed>;
  memberships?: MembershipSeed[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** Where a problem was found, used to build helpful error messages. */
export interface SeedLocation {
  /** Source file path (when known). */
  file?: string;
  /** Dotted YAML path, e.g. `users.alice.email` or `memberships[0].user`. */
  path?: string;
}

export class SeedValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Seed validation failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "SeedValidationError";
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locate(file: string | undefined, path: string): string {
  return file ? `${file} (${path})` : path;
}

export function isValidSeedKey(key: string): boolean {
  return SEED_KEY_PATTERN.test(key);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

// ─── Phase 1: structural validation ─────────────────────────────────────────

/**
 * Validate a parsed YAML value as a {@link SeedDocument}, collecting every
 * structural problem before throwing a single aggregated error.
 *
 * @param raw  The value returned by the YAML parser.
 * @param file Optional source file path, included in error messages.
 */
export function validateSeedDocument(raw: unknown, file?: string): SeedDocument {
  const issues: string[] = [];

  if (!isPlainObject(raw)) {
    throw new SeedValidationError([
      `${file ?? "document"}: expected a YAML mapping at the top level`,
    ]);
  }

  // Unknown top-level sections.
  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_SECTIONS as readonly string[]).includes(key)) {
      issues.push(
        `${locate(file, key)}: unknown top-level section "${key}". Allowed: ${TOP_LEVEL_SECTIONS.join(", ")}`
      );
    }
  }

  // version
  if (raw.version !== undefined && raw.version !== SEED_VERSION) {
    issues.push(
      `${locate(file, "version")}: unsupported version ${String(raw.version)} (expected ${SEED_VERSION})`
    );
  }

  // metadata
  if (raw.metadata !== undefined && !isPlainObject(raw.metadata)) {
    issues.push(`${locate(file, "metadata")}: must be a mapping`);
  }

  validateKeyedSection(raw.enterprises, "enterprises", file, issues, validateEnterprise);
  validateKeyedSection(
    raw.organizationTemplates,
    "organizationTemplates",
    file,
    issues,
    validateOrganizationTemplate
  );
  validateKeyedSection(raw.organizations, "organizations", file, issues, validateOrganization);
  validateKeyedSection(raw.users, "users", file, issues, validateUser);
  validateKeyedSection(raw.teams, "teams", file, issues, validateTeam);
  validateMemberships(raw.memberships, file, issues);

  if (issues.length > 0) throw new SeedValidationError(issues);

  return raw as SeedDocument;
}

type ResourceValidator = (
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
) => void;

function validateKeyedSection(
  section: unknown,
  name: string,
  file: string | undefined,
  issues: string[],
  validate: ResourceValidator
): void {
  if (section === undefined) return;
  if (!isPlainObject(section)) {
    issues.push(`${locate(file, name)}: must be a mapping of "<key>: { ... }"`);
    return;
  }
  for (const [key, value] of Object.entries(section)) {
    if (!isValidSeedKey(key)) {
      issues.push(
        `${locate(file, `${name}.${key}`)}: invalid key "${key}" — use lowercase kebab-case (e.g. "acme-main")`
      );
      continue;
    }
    validate(key, value, name, file, issues);
  }
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  path: string,
  file: string | undefined,
  issues: string[]
): void {
  const v = value[field];
  if (typeof v !== "string" || v.trim() === "") {
    issues.push(
      `${locate(file, `${path}.${field}`)}: "${field}" is required and must be a non-empty string`
    );
  }
}

function validateEnterprise(
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
): void {
  const path = `${section}.${key}`;
  if (!isPlainObject(value)) {
    issues.push(`${locate(file, path)}: must be a mapping`);
    return;
  }
  requireString(value, "name", path, file, issues);
}

function validateOrganizationTemplate(
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
): void {
  const path = `${section}.${key}`;
  if (!isPlainObject(value)) {
    issues.push(`${locate(file, path)}: must be a mapping`);
    return;
  }
  if (value.teams !== undefined) {
    if (!isPlainObject(value.teams)) {
      issues.push(`${locate(file, `${path}.teams`)}: must be a mapping of "<key>: { ... }"`);
    } else {
      for (const [teamKey, teamValue] of Object.entries(value.teams)) {
        const teamPath = `${path}.teams.${teamKey}`;
        if (!isValidSeedKey(teamKey)) {
          issues.push(
            `${locate(file, teamPath)}: invalid team key "${teamKey}" — use lowercase kebab-case`
          );
          continue;
        }
        if (!isPlainObject(teamValue)) {
          issues.push(`${locate(file, teamPath)}: must be a mapping`);
          continue;
        }
        requireString(teamValue, "name", teamPath, file, issues);
      }
    }
  }
}

function validateOrganization(
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
): void {
  const path = `${section}.${key}`;
  if (!isPlainObject(value)) {
    issues.push(`${locate(file, path)}: must be a mapping`);
    return;
  }
  requireString(value, "name", path, file, issues);
  if (value.enterprise !== undefined && typeof value.enterprise !== "string") {
    issues.push(`${locate(file, `${path}.enterprise`)}: must be a string reference`);
  }
  if (value.template !== undefined && typeof value.template !== "string") {
    issues.push(`${locate(file, `${path}.template`)}: must be a string reference`);
  }
  if (value.allowAutoJoin !== undefined && typeof value.allowAutoJoin !== "boolean") {
    issues.push(`${locate(file, `${path}.allowAutoJoin`)}: must be a boolean`);
  }
}

function validateUser(
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
): void {
  const path = `${section}.${key}`;
  if (!isPlainObject(value)) {
    issues.push(`${locate(file, path)}: must be a mapping`);
    return;
  }
  requireString(value, "name", path, file, issues);
  requireString(value, "email", path, file, issues);
  if (typeof value.email === "string" && value.email.trim() !== "" && !isValidEmail(value.email)) {
    issues.push(`${locate(file, `${path}.email`)}: "${value.email}" is not a valid email address`);
  }
}

function validateTeam(
  key: string,
  value: unknown,
  section: string,
  file: string | undefined,
  issues: string[]
): void {
  const path = `${section}.${key}`;
  if (!isPlainObject(value)) {
    issues.push(`${locate(file, path)}: must be a mapping`);
    return;
  }
  requireString(value, "name", path, file, issues);
  requireString(value, "organization", path, file, issues);
}

function validateMemberships(section: unknown, file: string | undefined, issues: string[]): void {
  if (section === undefined) return;
  if (!Array.isArray(section)) {
    issues.push(`${locate(file, "memberships")}: must be a list`);
    return;
  }
  section.forEach((entry, index) => {
    const path = `memberships[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(`${locate(file, path)}: must be a mapping`);
      return;
    }
    requireString(entry, "user", path, file, issues);
    requireString(entry, "organization", path, file, issues);
    if (
      entry.role !== undefined &&
      !ORG_MEMBERSHIP_ROLES.includes(entry.role as OrgMembershipRole)
    ) {
      issues.push(
        `${locate(file, `${path}.role`)}: invalid role "${String(entry.role)}". Allowed: ${ORG_MEMBERSHIP_ROLES.join(", ")}`
      );
    }
    if (entry.teams !== undefined) {
      if (!Array.isArray(entry.teams)) {
        issues.push(`${locate(file, `${path}.teams`)}: must be a list of team references`);
      } else {
        entry.teams.forEach((t, ti) => {
          if (typeof t !== "string") {
            issues.push(`${locate(file, `${path}.teams[${ti}]`)}: must be a string reference`);
          }
        });
      }
    }
  });
}
