/**
 * Phase 2: reference resolution.
 *
 * Verifies that every cross-resource reference in the merged import context can
 * be resolved, and computes the concrete set of teams that should exist in each
 * organization — both teams declared directly in the `teams` section and teams
 * contributed by an organization template. Membership team references are then
 * validated against that per-organization team set.
 *
 * DB/service free — safe to unit-test without a Mongo connection.
 */

import { SeedValidationError } from "./schema.js";
import type { ImportContext } from "./merge.js";

/** A team to be materialized in a specific organization. */
export interface ResolvedTeam {
  /** Stable seed key (explicit team key or template team key). */
  key: string;
  name: string;
  description?: string;
  /** Where the team came from. */
  source: "explicit" | "template";
}

export interface ResolvedContext extends ImportContext {
  /** orgKey → (teamKey → resolved team). */
  teamsByOrg: Map<string, Map<string, ResolvedTeam>>;
}

/**
 * Resolve all references in the import context, returning a
 * {@link ResolvedContext}. Throws a {@link SeedValidationError} listing every
 * unresolved or conflicting reference.
 */
export function resolveReferences(context: ImportContext): ResolvedContext {
  const issues: string[] = [];
  const teamsByOrg = new Map<string, Map<string, ResolvedTeam>>();

  const orgKeys = new Set(context.organizations.keys());
  const ensureOrgTeams = (orgKey: string): Map<string, ResolvedTeam> => {
    let map = teamsByOrg.get(orgKey);
    if (!map) {
      map = new Map();
      teamsByOrg.set(orgKey, map);
    }
    return map;
  };

  // Organizations: enterprise + template references, and template-defined teams.
  for (const { key, file, value } of context.organizations.values()) {
    if (value.enterprise && !context.enterprises.has(value.enterprise)) {
      issues.push(
        `${file} (organizations.${key}.enterprise): unknown enterprise "${value.enterprise}"`
      );
    }

    if (value.template) {
      const template = context.organizationTemplates.get(value.template);
      if (!template) {
        issues.push(
          `${file} (organizations.${key}.template): unknown organizationTemplate "${value.template}"`
        );
      } else {
        const orgTeams = ensureOrgTeams(key);
        for (const [teamKey, teamSeed] of Object.entries(template.value.teams ?? {})) {
          orgTeams.set(teamKey, {
            key: teamKey,
            name: teamSeed.name,
            description: teamSeed.description,
            source: "template",
          });
        }
      }
    }
  }

  // Explicit teams: organization reference + collision with template teams.
  for (const { key, file, value } of context.teams.values()) {
    if (!orgKeys.has(value.organization)) {
      issues.push(
        `${file} (teams.${key}.organization): unknown organization "${value.organization}"`
      );
      continue;
    }
    const orgTeams = ensureOrgTeams(value.organization);
    if (orgTeams.has(key)) {
      issues.push(
        `${file} (teams.${key}): team key "${key}" collides with a template-defined team in organization "${value.organization}"`
      );
      continue;
    }
    orgTeams.set(key, {
      key,
      name: value.name,
      description: value.description,
      source: "explicit",
    });
  }

  // Explicit parentTeam references (validated after all teams are registered).
  for (const { key, file, value } of context.teams.values()) {
    if (!value.parentTeam) continue;
    const orgTeams = teamsByOrg.get(value.organization);
    if (!orgTeams?.has(value.parentTeam)) {
      issues.push(
        `${file} (teams.${key}.parentTeam): unknown team "${value.parentTeam}" in organization "${value.organization}"`
      );
    }
  }

  // Memberships: user, organization, and team references.
  for (const { index, file, value } of context.memberships) {
    if (!context.users.has(value.user)) {
      issues.push(`${file} (memberships[${index}].user): unknown user "${value.user}"`);
    }
    const orgExists = orgKeys.has(value.organization);
    if (!orgExists) {
      issues.push(
        `${file} (memberships[${index}].organization): unknown organization "${value.organization}"`
      );
    }
    for (const teamKey of value.teams ?? []) {
      const orgTeams = orgExists ? teamsByOrg.get(value.organization) : undefined;
      if (!orgTeams?.has(teamKey)) {
        issues.push(
          `${file} (memberships[${index}].teams): team "${teamKey}" is not defined in organization "${value.organization}"`
        );
      }
    }
  }

  if (issues.length > 0) throw new SeedValidationError(issues);

  return { ...context, teamsByOrg };
}
