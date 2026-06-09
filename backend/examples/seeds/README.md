# Seed YAML import

Docker-Compose-inspired seed files for populating a local TimeHuddle database
with enterprises, organizations, users, teams, memberships, and reusable
organization templates.

A single YAML document can declare one or many resource sections. Every file
here is a valid, self-contained example; the [`acme-demo/`](./acme-demo/)
directory shows the same data split across multiple files that resolve
references across each other when imported together.

## Running an import

```bash
cd backend
nvm use

# Import a single combined file
npm run seed:import -- ./examples/seeds/acme-demo.yml

# Import every .yml/.yaml file in a directory (merged into one context)
npm run seed:import -- ./examples/seeds/acme-demo/

# Preview without writing anything
npm run seed:import -- ./examples/seeds/acme-demo/ -- --dry-run
```

Imports are **idempotent** — re-running the same seed will not create duplicate
enterprises, organizations, users, teams, or memberships. Enterprises and
organizations are matched by `slug`, users by `email`, teams by name within an
organization, and memberships by `(organization, user)`.

## Format

```yaml
version: 1

metadata:
  name: Acme Demo Seed
  description: Example enterprise/org/users/teams for local development.

enterprises:
  acme: # ← stable seed key, used for references
    name: Acme Corporation

organizationTemplates:
  basic-agency:
    name: Basic Agency Organization
    teams:
      leadership: { name: Leadership }
      engineering: { name: Engineering }

organizations:
  acme-main:
    name: Acme Main Office
    enterprise: acme # ← reference to enterprises.acme
    template: basic-agency # ← teams from the template are created in this org

users:
  alice:
    name: Alice Adams
    email: alice@example.com

teams:
  platform:
    name: Platform
    organization: acme-main

memberships:
  - user: alice
    organization: acme-main
    role: owner # owner | admin | member (default: member)
    teams:
      - leadership # template-defined team
      - platform # directly-defined team
```

### Rules

- **No top-level `kind`.** A file contains one or more resource sections.
- **Stable keys are identifiers.** Each map key (e.g. `alice`, `acme-main`) is
  the seed key used to reference that resource. Keys must be lowercase
  kebab-case (`acme-main`, `team-1`).
- **Generated database IDs never appear in YAML.**
- **References are simple local keys** — `enterprise: acme`, `organization:
  acme-main`, `template: basic-agency`, `user: alice`, `team: engineering`.
- **Any single section is valid on its own** — a users-only file, a
  template-only file, or a memberships-only file are all accepted, as long as a
  memberships file's references resolve within the import (across all files in a
  directory).

### Organization templates

`organizationTemplates` are a seed-time convenience: they are **not** persisted
as a separate entity. When an organization references a template, the template's
teams are materialized as real teams inside that organization. Memberships can
then reference those teams by their template key.

## Validation

Imports run two validation phases and report every problem with file path and
YAML path:

1. **Structural** — valid YAML, supported `version`, known sections, valid keys,
   required fields, email format, and role enum values.
2. **Reference resolution** — referenced enterprises, templates, organizations,
   users, and teams all exist; template-defined teams are referenceable by
   memberships; duplicate keys across files are rejected.
