/**
 * Importer / applicator.
 *
 * Applies a {@link ResolvedContext} to the database in a deterministic order
 * (enterprises → organizations → users → teams → memberships). Every step is
 * idempotent: re-importing the same seed will not create duplicate enterprises,
 * organizations, users, teams, or memberships.
 *
 * This is the only seed module that touches the database / services.
 */

import { ObjectId } from "mongodb";

import { auth } from "../lib/auth.js";
import { slugify } from "../lib/slug.js";
import { orgService } from "../services/org.service.js";
import {
  enterprisesCollection,
  organizationsCollection,
  orgMembersCollection,
  teamsCollection,
  usersCollection,
} from "../models/index.js";
import type { ResolvedContext } from "./resolver.js";

/** Default password applied to seeded users that omit one. */
const DEFAULT_SEED_PASSWORD = "Password1!";

export type ResourceAction = "created" | "skipped" | "updated";

export interface ResourceResult {
  key: string;
  action: ResourceAction;
  detail?: string;
}

export interface SeedImportSummary {
  dryRun: boolean;
  enterprises: ResourceResult[];
  organizations: ResourceResult[];
  users: ResourceResult[];
  teams: ResourceResult[];
  memberships: ResourceResult[];
}

export interface ApplyOptions {
  dryRun?: boolean;
  /** Sink for progress logging. Defaults to `console.log`. */
  log?: (message: string) => void;
}

function generateTeamCode(): string {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

/**
 * Apply the resolved seed context to the database.
 *
 * @returns A per-resource summary of what was created, skipped, or updated.
 */
export async function applySeed(
  context: ResolvedContext,
  options: ApplyOptions = {}
): Promise<SeedImportSummary> {
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? ((message: string) => console.log(message));

  const summary: SeedImportSummary = {
    dryRun,
    enterprises: [],
    organizations: [],
    users: [],
    teams: [],
    memberships: [],
  };

  // seed key → resolved database identifier.
  const enterpriseIdByKey = new Map<string, string>();
  const orgIdByKey = new Map<string, string>();
  const userIdByKey = new Map<string, string>();
  // `${orgKey}/${teamKey}` → team database id.
  const teamIdByOrgTeam = new Map<string, string>();

  // ─── Enterprises ──────────────────────────────────────────────────────────
  for (const { key, value } of context.enterprises.values()) {
    const name = value.name.trim();
    const slug = slugify(value.slug ?? name) || `enterprise-${key}`;
    const existing = await enterprisesCollection().findOne({ slug });
    if (existing) {
      enterpriseIdByKey.set(key, existing._id.toHexString());
      summary.enterprises.push({ key, action: "skipped", detail: `slug "${slug}" exists` });
      continue;
    }
    const id = new ObjectId();
    if (!dryRun) {
      await enterprisesCollection().insertOne({
        _id: id,
        name,
        slug,
        owners: [],
        admins: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    enterpriseIdByKey.set(key, id.toHexString());
    summary.enterprises.push({ key, action: "created", detail: `slug "${slug}"` });
    log(`✓ enterprise: ${key} (${slug})`);
  }

  // ─── Organizations ────────────────────────────────────────────────────────
  for (const { key, value } of context.organizations.values()) {
    const name = value.name.trim();
    const slug = slugify(value.slug ?? name) || `org-${key}`;
    const enterpriseId = value.enterprise ? enterpriseIdByKey.get(value.enterprise) : undefined;
    const existing = await organizationsCollection().findOne({ slug });
    if (existing) {
      orgIdByKey.set(key, existing._id.toHexString());
      summary.organizations.push({ key, action: "skipped", detail: `slug "${slug}" exists` });
      continue;
    }
    const id = new ObjectId();
    if (!dryRun) {
      await organizationsCollection().insertOne({
        _id: id,
        enterpriseId,
        name,
        slug,
        owners: [],
        admins: [],
        allowAutoJoin: value.allowAutoJoin !== false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    orgIdByKey.set(key, id.toHexString());
    summary.organizations.push({ key, action: "created", detail: `slug "${slug}"` });
    log(`✓ organization: ${key} (${slug})`);
  }

  // ─── Users ────────────────────────────────────────────────────────────────
  for (const { key, value } of context.users.values()) {
    const email = value.email.trim().toLowerCase();
    const existing = await usersCollection().findOne({ email });
    if (existing) {
      userIdByKey.set(key, existing._id.toHexString());
      await maybeSetUsername(existing._id, value.username, dryRun);
      summary.users.push({ key, action: "skipped", detail: `email "${email}" exists` });
      continue;
    }

    if (dryRun) {
      summary.users.push({ key, action: "created", detail: `email "${email}"` });
      log(`✓ user: ${key} (${email}) [dry-run]`);
      continue;
    }

    try {
      await auth.api.signUpEmail({
        body: {
          name: value.name.trim(),
          email,
          password: value.password ?? DEFAULT_SEED_PASSWORD,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already|exist/i.test(message)) throw err;
    }

    const created = await usersCollection().findOne({ email });
    if (!created) {
      summary.users.push({ key, action: "skipped", detail: `could not create "${email}"` });
      continue;
    }
    userIdByKey.set(key, created._id.toHexString());
    await maybeSetUsername(created._id, value.username, dryRun);
    summary.users.push({ key, action: "created", detail: `email "${email}"` });
    log(`✓ user: ${key} (${email})`);
  }

  // ─── Teams ────────────────────────────────────────────────────────────────
  for (const [orgKey, orgTeams] of context.teamsByOrg) {
    const orgId = orgIdByKey.get(orgKey);
    if (!orgId) continue; // dry-run with an org that does not yet exist
    for (const team of orgTeams.values()) {
      const existing = await teamsCollection().findOne({
        orgId,
        name: team.name,
        isPersonal: { $ne: true },
      });
      if (existing) {
        teamIdByOrgTeam.set(`${orgKey}/${team.key}`, existing._id.toHexString());
        summary.teams.push({ key: `${orgKey}/${team.key}`, action: "skipped" });
        continue;
      }
      const id = new ObjectId();
      if (!dryRun) {
        await teamsCollection().insertOne({
          _id: id,
          orgId,
          parentTeamId: null,
          name: team.name,
          description: team.description,
          members: [],
          admins: [],
          code: generateTeamCode(),
          isPersonal: false,
          createdAt: new Date(),
        });
      }
      teamIdByOrgTeam.set(`${orgKey}/${team.key}`, id.toHexString());
      summary.teams.push({ key: `${orgKey}/${team.key}`, action: "created", detail: team.name });
      log(`✓ team: ${orgKey}/${team.key} (${team.name})`);
    }
  }

  // ─── Memberships ──────────────────────────────────────────────────────────
  for (const { value } of context.memberships) {
    const userId = userIdByKey.get(value.user);
    const orgId = orgIdByKey.get(value.organization);
    const refKey = `${value.user}@${value.organization}`;
    if (!userId || !orgId) {
      summary.memberships.push({ key: refKey, action: "skipped", detail: "unresolved (dry-run)" });
      continue;
    }
    const role = value.role ?? "member";
    const existing = await orgMembersCollection().findOne({ orgId, userId });

    if (!dryRun) {
      await orgService.addOrgMember(orgId, userId, role, false);
      for (const teamKey of value.teams ?? []) {
        const teamId = teamIdByOrgTeam.get(`${value.organization}/${teamKey}`);
        if (!teamId) continue;
        await teamsCollection().updateOne(
          { _id: new ObjectId(teamId) },
          { $addToSet: { members: userId }, $set: { updatedAt: new Date() } }
        );
      }
    }

    summary.memberships.push({
      key: refKey,
      action: existing ? "updated" : "created",
      detail: `role ${role}`,
    });
    log(`✓ membership: ${refKey} (${role})`);
  }

  return summary;
}

async function maybeSetUsername(
  userId: ObjectId,
  username: string | undefined,
  dryRun: boolean
): Promise<void> {
  if (!username || dryRun) return;
  const taken = await usersCollection().findOne({ username, _id: { $ne: userId } });
  if (taken) return;
  await usersCollection().updateOne({ _id: userId }, { $set: { username, updatedAt: new Date() } });
}
