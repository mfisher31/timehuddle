/**
 * Seed YAML pipeline — unit tests.
 *
 * Covers the database-free portion of the importer: structural validation,
 * loading single files and directories, cross-file merge + duplicate detection,
 * and reference resolution (including template-defined teams). These tests do
 * not require a Mongo connection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateSeedDocument, SeedValidationError } from "../src/seed/schema.js";
import { loadSeedDocuments } from "../src/seed/loader.js";
import { mergeSeedDocuments } from "../src/seed/merge.js";
import { resolveReferences } from "../src/seed/resolver.js";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "seed-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writeYaml(name: string, contents: string): Promise<string> {
  const file = path.join(workDir, name);
  await writeFile(file, contents, "utf8");
  return file;
}

// ─── Structural validation ──────────────────────────────────────────────────

describe("validateSeedDocument", () => {
  it("accepts a users-only document", () => {
    const doc = validateSeedDocument({
      version: 1,
      users: { alice: { name: "Alice Adams", email: "alice@example.com" } },
    });
    expect(doc.users?.alice.email).toBe("alice@example.com");
  });

  it("accepts a template-only document", () => {
    const doc = validateSeedDocument({
      version: 1,
      organizationTemplates: {
        "basic-agency": { name: "Basic Agency", teams: { leadership: { name: "Leadership" } } },
      },
    });
    expect(doc.organizationTemplates?.["basic-agency"].teams?.leadership.name).toBe("Leadership");
  });

  it("rejects unknown top-level sections", () => {
    expect(() => validateSeedDocument({ version: 1, widgets: {} })).toThrow(SeedValidationError);
    try {
      validateSeedDocument({ version: 1, widgets: {} });
    } catch (err) {
      expect((err as SeedValidationError).issues.join("\n")).toMatch(/unknown top-level section/);
    }
  });

  it("rejects an unsupported version", () => {
    expect(() => validateSeedDocument({ version: 2, users: {} })).toThrow(/unsupported version/);
  });

  it("rejects invalid resource keys", () => {
    try {
      validateSeedDocument({ users: { "Alice Adams": { name: "Alice", email: "a@b.co" } } });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SeedValidationError);
      expect((err as SeedValidationError).issues.join("\n")).toMatch(/invalid key "Alice Adams"/);
    }
  });

  it("rejects invalid email formats", () => {
    expect(() =>
      validateSeedDocument({ users: { alice: { name: "Alice", email: "not-an-email" } } })
    ).toThrow(/not a valid email/);
  });

  it("rejects invalid membership roles", () => {
    expect(() =>
      validateSeedDocument({
        memberships: [{ user: "alice", organization: "acme-main", role: "superuser" }],
      })
    ).toThrow(/invalid role/);
  });

  it("requires required fields", () => {
    expect(() => validateSeedDocument({ users: { alice: { name: "Alice" } } })).toThrow(
      /"email" is required/
    );
  });
});

// ─── Loading ────────────────────────────────────────────────────────────────

describe("loadSeedDocuments", () => {
  it("parses a single valid YAML file", async () => {
    const file = await writeYaml(
      "single.yml",
      ["version: 1", "users:", "  alice:", "    name: Alice", "    email: alice@example.com"].join(
        "\n"
      )
    );
    const docs = await loadSeedDocuments(file);
    expect(docs).toHaveLength(1);
    expect(docs[0].document.users?.alice.email).toBe("alice@example.com");
  });

  it("loads and merges every YAML file in a directory", async () => {
    const dir = await mkdtemp(path.join(workDir, "dir-"));
    await writeFile(
      path.join(dir, "01-users.yml"),
      "version: 1\nusers:\n  alice:\n    name: Alice\n    email: alice@example.com\n",
      "utf8"
    );
    await writeFile(
      path.join(dir, "02-orgs.yml"),
      "version: 1\norganizations:\n  acme-main:\n    name: Acme Main\n",
      "utf8"
    );

    const docs = await loadSeedDocuments(dir);
    expect(docs).toHaveLength(2);

    const context = mergeSeedDocuments(docs);
    expect(context.users.has("alice")).toBe(true);
    expect(context.organizations.has("acme-main")).toBe(true);
  });
});

// ─── Merge ──────────────────────────────────────────────────────────────────

describe("mergeSeedDocuments", () => {
  it("rejects duplicate resource keys across files", async () => {
    const a = await writeYaml(
      "dup-a.yml",
      "version: 1\nusers:\n  alice:\n    name: Alice A\n    email: a@example.com\n"
    );
    const b = await writeYaml(
      "dup-b.yml",
      "version: 1\nusers:\n  alice:\n    name: Alice B\n    email: b@example.com\n"
    );
    const docs = await loadSeedDocuments(a).then(async (first) => [
      ...first,
      ...(await loadSeedDocuments(b)),
    ]);

    expect(() => mergeSeedDocuments(docs)).toThrow(/Duplicate users key "alice"/);
  });
});

// ─── Reference resolution ─────────────────────────────────────────────────────

describe("resolveReferences", () => {
  it("resolves references across files, including template teams", async () => {
    const dir = await mkdtemp(path.join(workDir, "resolve-"));
    await writeFile(
      path.join(dir, "01-template.yml"),
      "version: 1\norganizationTemplates:\n  basic:\n    teams:\n      engineering:\n        name: Engineering\n",
      "utf8"
    );
    await writeFile(
      path.join(dir, "02-org.yml"),
      "version: 1\nenterprises:\n  acme:\n    name: Acme\norganizations:\n  acme-main:\n    name: Acme Main\n    enterprise: acme\n    template: basic\n",
      "utf8"
    );
    await writeFile(
      path.join(dir, "03-users.yml"),
      "version: 1\nusers:\n  bob:\n    name: Bob\n    email: bob@example.com\n",
      "utf8"
    );
    await writeFile(
      path.join(dir, "04-memberships.yml"),
      "version: 1\nmemberships:\n  - user: bob\n    organization: acme-main\n    role: member\n    teams:\n      - engineering\n",
      "utf8"
    );

    const resolved = resolveReferences(mergeSeedDocuments(await loadSeedDocuments(dir)));
    const orgTeams = resolved.teamsByOrg.get("acme-main");
    expect(orgTeams?.get("engineering")?.name).toBe("Engineering");
    expect(resolved.memberships).toHaveLength(1);
  });

  it("rejects an unknown enterprise reference", () => {
    const context = mergeSeedDocuments([
      {
        file: "x.yml",
        document: {
          organizations: { "acme-main": { name: "Acme Main", enterprise: "ghost" } },
        },
      },
    ]);
    expect(() => resolveReferences(context)).toThrow(/unknown enterprise "ghost"/);
  });

  it("rejects a membership team not defined in the organization", () => {
    const context = mergeSeedDocuments([
      {
        file: "x.yml",
        document: {
          users: { alice: { name: "Alice", email: "alice@example.com" } },
          organizations: { "acme-main": { name: "Acme Main" } },
          memberships: [{ user: "alice", organization: "acme-main", teams: ["ghost"] }],
        },
      },
    ]);
    expect(() => resolveReferences(context)).toThrow(/team "ghost" is not defined/);
  });
});
