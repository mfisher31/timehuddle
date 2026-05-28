import "dotenv/config";
import { ObjectId } from "mongodb";
import { connectDB, client } from "../src/lib/db.js";
import { auth } from "../src/lib/auth.js";
import {
  teamsCollection,
  usersCollection,
  ticketsCollection,
  clockEventsCollection,
  workItemsCollection,
  timersCollection,
} from "../src/models/index.js";
import { applySeedHierarchy } from "./seed-hierarchy.js";

const SEED_USERS = [
  { name: "Alice Admin", email: "alice@example.com", password: "Password1!" },
  { name: "Bob Builder", email: "bob@example.com", password: "Password1!" },
  { name: "Carol Dev", email: "carol@example.com", password: "Password1!" },
  { name: "Dan Developer", email: "dan@example.com", password: "Password1!" },
  { name: "Eve Engineer", email: "eve@example.com", password: "Password1!" },
  { name: "Frank Finance", email: "frank@example.com", password: "Password1!" },
  { name: "Grace Ledger", email: "grace@example.com", password: "Password1!" },
  { name: "Hannah HR", email: "hannah@example.com", password: "Password1!" },
  { name: "Ian IT", email: "ian@example.com", password: "Password1!" },
  { name: "Jules Support", email: "jules@example.com", password: "Password1!" },
  { name: "Kira Product", email: "kira@example.com", password: "Password1!" },
  { name: "Liam Designer", email: "liam@example.com", password: "Password1!" },
  { name: "Maya Marketing", email: "maya@example.com", password: "Password1!" },
  { name: "Noah Ops", email: "noah@example.com", password: "Password1!" },
  { name: "Olivia Analyst", email: "olivia@example.com", password: "Password1!" },
  { name: "Parker Frontend", email: "parker@example.com", password: "Password1!" },
  { name: "Quinn QA", email: "quinn@example.com", password: "Password1!" },
  { name: "Riley Backend", email: "riley@example.com", password: "Password1!" },
  { name: "Sam Fullstack", email: "sam@example.com", password: "Password1!" },
  { name: "Tanya Tech Lead", email: "tanya@example.com", password: "Password1!" },
  { name: "Uma Engineer", email: "uma@example.com", password: "Password1!" },
];

// Keep exactly one seeded user unclaimed for username-claim flows.
const UNCLAIMED_USERNAME_EMAIL = "olivia@example.com";

const SEED_TEAMS = [
  {
    name: "Developers",
    code: "ZDLYFY9T",
    description: "Frontend and backend engineers building TimeHuddle.",
    admins: ["alice@example.com", "carol@example.com", "tanya@example.com"],
    members: [
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dan@example.com",
      "eve@example.com",
      "ian@example.com",
      "parker@example.com",
      "quinn@example.com",
      "riley@example.com",
      "sam@example.com",
      "tanya@example.com",
      "uma@example.com",
    ],
  },
  {
    name: "Accounting",
    code: "P2SRHYYK",
    description: "Billing, payroll, and financial reporting.",
    admins: ["frank@example.com"],
    members: ["frank@example.com", "grace@example.com", "olivia@example.com"],
  },
  {
    name: "Product",
    code: "FAKASXQ9",
    description: "Product planning and roadmap prioritization.",
    admins: ["kira@example.com", "tanya@example.com"],
    members: ["kira@example.com", "alice@example.com", "liam@example.com", "tanya@example.com"],
  },
  {
    name: "Design",
    code: "MHGT2L3Z",
    description: "UX research, visual design, and prototypes.",
    admins: ["liam@example.com"],
    members: ["liam@example.com", "kira@example.com", "maya@example.com", "parker@example.com"],
  },
  {
    name: "Support",
    code: "180YR2C3",
    description: "Customer support and escalation management.",
    admins: ["jules@example.com", "quinn@example.com"],
    members: ["jules@example.com", "hannah@example.com", "noah@example.com", "quinn@example.com"],
  },
  {
    name: "Operations",
    code: "R0VCXWDP",
    description: "Internal IT, onboarding, and environment operations.",
    admins: ["noah@example.com", "ian@example.com", "riley@example.com"],
    members: [
      "noah@example.com",
      "ian@example.com",
      "hannah@example.com",
      "maya@example.com",
      "riley@example.com",
      "uma@example.com",
    ],
  },
];

type TeamSeed = (typeof SEED_TEAMS)[number];

function emailsToIds(emails: string[], userIdsByEmail: Map<string, string>): string[] {
  return Array.from(
    new Set(
      emails.map((email) => userIdsByEmail.get(email)).filter((id): id is string => Boolean(id))
    )
  );
}

async function upsertSeedTeam(team: TeamSeed, userIdsByEmail: Map<string, string>) {
  const memberIds = emailsToIds(team.members, userIdsByEmail);
  const adminIds = emailsToIds(team.admins, userIdsByEmail).filter((id) => memberIds.includes(id));

  if (memberIds.length === 0) {
    console.log(`- Skipped team (no valid members): ${team.name}`);
    return;
  }

  const existing = await teamsCollection().findOne({ name: team.name, isPersonal: false });

  if (!existing) {
    await teamsCollection().insertOne({
      _id: new ObjectId(),
      name: team.name,
      description: team.description,
      members: memberIds,
      admins: adminIds,
      code: team.code,
      isPersonal: false,
      createdAt: new Date(),
    });
    console.log(`✓ Created team: ${team.name}`);
    return;
  }

  await teamsCollection().updateOne(
    { _id: existing._id },
    {
      $set: {
        description: team.description,
        code: team.code,
        updatedAt: new Date(),
      },
      $addToSet: {
        members: { $each: memberIds },
        admins: { $each: adminIds },
      },
    }
  );
  console.log(`- Updated team: ${team.name}`);
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

const SEED_TICKETS: {
  team: string;
  title: string;
  status: "open" | "in-progress" | "blocked" | "reviewed" | "closed";
  priority: "low" | "medium" | "high" | "critical";
  createdBy: string;
  assignedTo: string | null;
}[] = [
  // Developers
  {
    team: "Developers",
    title: "Set up CI/CD pipeline",
    status: "closed",
    priority: "high",
    createdBy: "alice@example.com",
    assignedTo: "bob@example.com",
  },
  {
    team: "Developers",
    title: "Refactor timer state models",
    status: "in-progress",
    priority: "high",
    createdBy: "alice@example.com",
    assignedTo: "carol@example.com",
  },
  {
    team: "Developers",
    title: "Add dark mode support",
    status: "open",
    priority: "medium",
    createdBy: "carol@example.com",
    assignedTo: "dan@example.com",
  },
  {
    team: "Developers",
    title: "Fix mobile layout on timers page",
    status: "open",
    priority: "medium",
    createdBy: "bob@example.com",
    assignedTo: "eve@example.com",
  },
  {
    team: "Developers",
    title: "Write unit tests for timer service",
    status: "in-progress",
    priority: "high",
    createdBy: "carol@example.com",
    assignedTo: "ian@example.com",
  },
  {
    team: "Developers",
    title: "Implement push notifications",
    status: "open",
    priority: "low",
    createdBy: "alice@example.com",
    assignedTo: null,
  },
  {
    team: "Developers",
    title: "Upgrade to Vite 8",
    status: "closed",
    priority: "medium",
    createdBy: "dan@example.com",
    assignedTo: "dan@example.com",
  },
  // Product
  {
    team: "Product",
    title: "Define MVP feature set",
    status: "closed",
    priority: "critical",
    createdBy: "kira@example.com",
    assignedTo: "kira@example.com",
  },
  {
    team: "Product",
    title: "Write user stories for time tracking",
    status: "reviewed",
    priority: "high",
    createdBy: "kira@example.com",
    assignedTo: "alice@example.com",
  },
  {
    team: "Product",
    title: "Roadmap Q3 2026",
    status: "in-progress",
    priority: "medium",
    createdBy: "kira@example.com",
    assignedTo: "liam@example.com",
  },
  {
    team: "Product",
    title: "Accessibility audit",
    status: "open",
    priority: "medium",
    createdBy: "liam@example.com",
    assignedTo: null,
  },
  // Design
  {
    team: "Design",
    title: "Design system token alignment",
    status: "in-progress",
    priority: "high",
    createdBy: "liam@example.com",
    assignedTo: "liam@example.com",
  },
  {
    team: "Design",
    title: "Timer page mobile mockups",
    status: "reviewed",
    priority: "medium",
    createdBy: "liam@example.com",
    assignedTo: "maya@example.com",
  },
  {
    team: "Design",
    title: "Onboarding flow illustrations",
    status: "open",
    priority: "low",
    createdBy: "maya@example.com",
    assignedTo: null,
  },
  // Support
  {
    team: "Support",
    title: "Document clock-in / clock-out flow",
    status: "closed",
    priority: "medium",
    createdBy: "jules@example.com",
    assignedTo: "hannah@example.com",
  },
  {
    team: "Support",
    title: "Build FAQ knowledge base",
    status: "in-progress",
    priority: "medium",
    createdBy: "jules@example.com",
    assignedTo: "noah@example.com",
  },
  // Accounting
  {
    team: "Accounting",
    title: "Monthly payroll reconciliation",
    status: "in-progress",
    priority: "high",
    createdBy: "frank@example.com",
    assignedTo: "grace@example.com",
  },
  {
    team: "Accounting",
    title: "Set up invoice export",
    status: "open",
    priority: "medium",
    createdBy: "grace@example.com",
    assignedTo: "frank@example.com",
  },
  // Operations
  {
    team: "Operations",
    title: "Docker Compose local dev stack",
    status: "closed",
    priority: "high",
    createdBy: "noah@example.com",
    assignedTo: "ian@example.com",
  },
  {
    team: "Operations",
    title: "Environment rotation script",
    status: "open",
    priority: "low",
    createdBy: "ian@example.com",
    assignedTo: null,
  },
];

async function seedTickets(
  userIdsByEmail: Map<string, string>,
  teamIdsByName: Map<string, string>
): Promise<Map<string, string>> {
  const ticketIdsByTitle = new Map<string, string>();
  for (const t of SEED_TICKETS) {
    const teamId = teamIdsByName.get(t.team);
    const createdBy = userIdsByEmail.get(t.createdBy);
    if (!teamId || !createdBy) continue;
    const existing = await ticketsCollection().findOne({ teamId, title: t.title });
    if (existing) {
      ticketIdsByTitle.set(t.title, existing._id.toHexString());
      console.log(`- Ticket exists: ${t.title}`);
      continue;
    }
    const id = new ObjectId();
    await ticketsCollection().insertOne({
      _id: id,
      teamId,
      title: t.title,
      github: "",
      status: t.status,
      priority: t.priority,
      createdBy,
      assignedTo: t.assignedTo ? (userIdsByEmail.get(t.assignedTo) ?? null) : null,
      createdAt: new Date(),
    });
    ticketIdsByTitle.set(t.title, id.toHexString());
    console.log(`✓ Ticket: ${t.title}`);
  }
  return ticketIdsByTitle;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Epoch ms for a specific hour:min on a day N days ago from now. */
function dayMs(daysAgo: number, hour: number, min = 0): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, min, 0, 0);
  return d.getTime();
}

/** Local ISO date string (YYYY-MM-DD) for a day N days ago. */
function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-CA");
}

const THREE_WEEK_OFFSETS = [0, 7, 14];

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function businessDaysAgoToCalendarDays(businessDaysAgo: number): number {
  const today = startOfLocalDay(new Date());
  const cursor = startOfLocalDay(new Date());

  // If today is weekend, anchor to the most recent weekday.
  while (isWeekend(cursor)) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let remaining = businessDaysAgo;
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() - 1);
    if (!isWeekend(cursor)) {
      remaining -= 1;
    }
  }

  return Math.round((today.getTime() - cursor.getTime()) / 86_400_000);
}

// ─── Clock events ─────────────────────────────────────────────────────────────

// [email, daysAgo, clockInHour, clockInMin, clockOutHour, clockOutMin]
// All entries are fully closed — seed data represents history only.
const CLOCK_SCHEDULE_BASE: [string, number, number, number, number, number][] = [
  ["alice@example.com", 4, 8, 5, 17, 12],
  ["alice@example.com", 3, 8, 15, 16, 50],
  ["alice@example.com", 2, 8, 0, 17, 30],
  ["alice@example.com", 1, 8, 22, 17, 0],
  ["alice@example.com", 0, 8, 10, 17, 0],

  ["bob@example.com", 4, 9, 0, 17, 30],
  ["bob@example.com", 3, 8, 55, 18, 5],
  ["bob@example.com", 2, 9, 10, 17, 45],
  ["bob@example.com", 1, 9, 0, 17, 0],
  ["bob@example.com", 0, 9, 5, 17, 30],

  ["carol@example.com", 4, 7, 50, 16, 30],
  ["carol@example.com", 3, 8, 0, 16, 45],
  ["carol@example.com", 2, 7, 55, 17, 0],
  ["carol@example.com", 1, 8, 5, 16, 55],

  ["dan@example.com", 4, 10, 0, 18, 30],
  ["dan@example.com", 3, 9, 45, 18, 15],
  ["dan@example.com", 2, 10, 5, 19, 0],
  ["dan@example.com", 1, 10, 0, 18, 0],

  ["eve@example.com", 4, 8, 30, 17, 0],
  ["eve@example.com", 3, 8, 35, 16, 50],
  ["eve@example.com", 1, 8, 40, 17, 10],
  ["eve@example.com", 0, 8, 30, 17, 0],
];

const CLOCK_SCHEDULE: [string, number, number, number, number, number][] =
  THREE_WEEK_OFFSETS.flatMap((weekOffset) =>
    CLOCK_SCHEDULE_BASE.map(([email, daysAgo, inH, inM, outH, outM]) => [
      email,
      businessDaysAgoToCalendarDays(daysAgo) + weekOffset,
      inH,
      inM,
      outH,
      outM,
    ])
  );

async function seedClockEvents(userIdsByEmail: Map<string, string>) {
  for (const [email, daysAgo, inH, inM, outH, outM] of CLOCK_SCHEDULE) {
    const userId = userIdsByEmail.get(email);
    if (!userId) continue;
    const startTime = dayMs(daysAgo, inH, inM);
    const isOpen = outH === 0 && outM === 0;
    const endTime = isOpen ? null : dayMs(daysAgo, outH, outM);
    const accumulatedTime = isOpen ? 0 : Math.round((endTime! - startTime) / 1000);
    const existing = await clockEventsCollection().findOne({
      userId,
      startTime: { $gte: startTime - 60_000, $lte: startTime + 60_000 },
    });
    if (existing) continue;
    await clockEventsCollection().insertOne({
      _id: new ObjectId(),
      userId,
      startTime,
      accumulatedTime,
      endTime,
    });
  }
  console.log("✓ Clock events seeded");
}

// ─── Time entries + timer sessions ────────────────────────────────────────────

// [email, daysAgo, ticketTitle, note, [[startH, startM, endH, endM], ...]]
type TimerSeed = [string, number, string, string, [number, number, number, number][]];

const TIMER_SEEDS_BASE: TimerSeed[] = [
  // ── "Refactor timer state models" ── alice (lead) + carol (tests) + bob (review)
  // alice: 4 days of sustained work with multiple sub-task entries per day
  [
    "alice@example.com",
    4,
    "Refactor timer state models",
    "Kickoff — schema design with team",
    [[9, 0, 10, 30]],
  ],
  [
    "alice@example.com",
    4,
    "Refactor timer state models",
    "WorkItem model draft",
    [
      [11, 0, 12, 30],
      [13, 30, 15, 0],
    ],
  ],
  [
    "alice@example.com",
    3,
    "Refactor timer state models",
    "Timer model + migration script",
    [[9, 0, 11, 30]],
  ],
  [
    "alice@example.com",
    3,
    "Refactor timer state models",
    "Backend routes — POST /timer-sessions",
    [[13, 0, 16, 0]],
  ],
  [
    "alice@example.com",
    2,
    "Refactor timer state models",
    "PATCH route + auth guards",
    [[8, 30, 11, 0]],
  ],
  [
    "alice@example.com",
    2,
    "Refactor timer state models",
    "PR cleanup and rebase",
    [[14, 0, 15, 30]],
  ],
  [
    "alice@example.com",
    1,
    "Refactor timer state models",
    "Review carol's test feedback",
    [[9, 0, 10, 0]],
  ],
  ["alice@example.com", 0, "Refactor timer state models", "Frontend integration", [[8, 15, 10, 0]]],
  // carol: testing the same ticket across 3 days
  [
    "carol@example.com",
    3,
    "Refactor timer state models",
    "Read alice's PR — understand new model shape",
    [[8, 0, 9, 0]],
  ],
  [
    "carol@example.com",
    3,
    "Refactor timer state models",
    "Unit tests for WorkItem service",
    [[9, 30, 12, 0]],
  ],
  [
    "carol@example.com",
    2,
    "Refactor timer state models",
    "Integration tests — session lifecycle",
    [[8, 0, 11, 30]],
  ],
  [
    "carol@example.com",
    2,
    "Refactor timer state models",
    "Edge cases: concurrent sessions, clock drift",
    [[13, 0, 15, 0]],
  ],
  [
    "carol@example.com",
    1,
    "Refactor timer state models",
    "Fix broken assertion after alice's rebase",
    [[8, 0, 9, 30]],
  ],
  // bob: one-day review pass
  ["bob@example.com", 1, "Refactor timer state models", "Code review pass", [[11, 0, 12, 30]]],
  [
    "bob@example.com",
    1,
    "Refactor timer state models",
    "Left review comments — API surface concerns",
    [[14, 0, 15, 0]],
  ],

  // ── "Set up CI/CD pipeline" ── alice + bob collaborate, then close it out
  ["alice@example.com", 4, "Set up CI/CD pipeline", "Repo secrets and env setup", [[8, 0, 9, 0]]],
  ["bob@example.com", 4, "Set up CI/CD pipeline", "Docker build step", [[9, 30, 12, 0]]],
  [
    "bob@example.com",
    4,
    "Set up CI/CD pipeline",
    "Deploy job + staging environment hook",
    [[13, 0, 15, 30]],
  ],
  [
    "alice@example.com",
    3,
    "Set up CI/CD pipeline",
    "Test gate — block merge on red",
    [[9, 0, 10, 0]],
  ],
  ["bob@example.com", 3, "Set up CI/CD pipeline", "", [[10, 30, 12, 0]]], // no note — just grinding it out
  ["alice@example.com", 2, "Set up CI/CD pipeline", "Final review and merge", [[9, 0, 10, 0]]],

  // ── "Fix mobile layout on timers page" ── bob owns, eve tests on device, dan drops in
  [
    "bob@example.com",
    4,
    "Fix mobile layout on timers page",
    "Breakpoint analysis — document current issues",
    [[15, 0, 17, 0]],
  ],
  [
    "bob@example.com",
    3,
    "Fix mobile layout on timers page",
    "Responsive table — collapse note column",
    [
      [9, 0, 11, 0],
      [13, 30, 15, 30],
    ],
  ],
  [
    "bob@example.com",
    2,
    "Fix mobile layout on timers page",
    "Week strip overflow fix",
    [[9, 0, 12, 30]],
  ],
  [
    "eve@example.com",
    2,
    "Fix mobile layout on timers page",
    "QA pass on iPhone 15 Pro",
    [[13, 0, 14, 30]],
  ],
  [
    "eve@example.com",
    1,
    "Fix mobile layout on timers page",
    "Testing on Android (Pixel 8)",
    [[8, 45, 12, 0]],
  ],
  [
    "dan@example.com",
    1,
    "Fix mobile layout on timers page",
    "Accessibility check — tab order",
    [[14, 30, 16, 0]],
  ],
  [
    "bob@example.com",
    0,
    "Fix mobile layout on timers page",
    "Final polish — PR ready",
    [[9, 10, 11, 0]],
  ],

  // ── "Add dark mode support" ── carol + dan share the work
  ["dan@example.com", 4, "Add dark mode support", "Token audit", [[10, 0, 12, 0]]],
  [
    "carol@example.com",
    4,
    "Add dark mode support",
    "Identify components missing dark variants",
    [[13, 0, 15, 30]],
  ],
  [
    "dan@example.com",
    3,
    "Add dark mode support",
    "Dark palette tokens — map to Tailwind vars",
    [[10, 0, 13, 0]],
  ],
  [
    "carol@example.com",
    3,
    "Add dark mode support",
    "AppHeader + Sidebar dark mode",
    [[13, 0, 14, 30]],
  ],
  ["carol@example.com", 2, "Add dark mode support", "Full component audit pass", [[8, 0, 12, 0]]],
  ["dan@example.com", 2, "Add dark mode support", "Migration and testing", [[10, 0, 18, 0]]],
  [
    "dan@example.com",
    1,
    "Add dark mode support",
    "Review fixes after carol's audit",
    [
      [10, 0, 12, 0],
      [14, 0, 17, 30],
    ],
  ],

  // ── "Write unit tests for timer service" ── carol primary, alice assists, ian chips in
  [
    "carol@example.com",
    4,
    "Write unit tests for timer service",
    "Timer session tests — start/stop/resume",
    [
      [8, 0, 11, 0],
      [13, 0, 15, 0],
    ],
  ],
  [
    "alice@example.com",
    3,
    "Write unit tests for timer service",
    "Route tests — POST /time-entries",
    [
      [9, 0, 11, 0],
      [14, 0, 16, 30],
    ],
  ],
  [
    "carol@example.com",
    3,
    "Write unit tests for timer service",
    "Service layer — createSession edge cases",
    [[8, 30, 10, 0]],
  ],
  ["ian@example.com", 3, "Write unit tests for timer service", "", [[14, 0, 16, 0]]], // no note
  [
    "carol@example.com",
    1,
    "Write unit tests for timer service",
    "Integration tests — full lifecycle",
    [
      [8, 0, 10, 0],
      [13, 30, 16, 0],
    ],
  ],
  [
    "ian@example.com",
    1,
    "Write unit tests for timer service",
    "CI runner config for backend tests",
    [[10, 0, 12, 0]],
  ],

  // ── "Upgrade to Vite 8" ── dan leads, bob assists
  [
    "dan@example.com",
    4,
    "Upgrade to Vite 8",
    "Research — changelog + breaking changes",
    [[10, 0, 12, 0]],
  ],
  [
    "bob@example.com",
    3,
    "Upgrade to Vite 8",
    "Dependency bump + build smoke test",
    [
      [9, 0, 10, 30],
      [14, 0, 17, 0],
    ],
  ],
  ["dan@example.com", 2, "Upgrade to Vite 8", "Migrate config — new plugin API", [[10, 0, 14, 0]]],
  ["dan@example.com", 2, "Upgrade to Vite 8", "Fix HMR breakage in dev", [[15, 0, 18, 0]]],
  ["bob@example.com", 1, "Upgrade to Vite 8", "Final QA — prod build diff", [[11, 0, 13, 0]]],

  // ── "Implement push notifications" ── eve solo
  ["eve@example.com", 4, "Implement push notifications", "Service worker setup", [[8, 30, 11, 30]]],
  [
    "eve@example.com",
    4,
    "Implement push notifications",
    "Push subscription API research",
    [[13, 0, 15, 0]],
  ],
  [
    "eve@example.com",
    3,
    "Implement push notifications",
    "FCM integration — server-side send",
    [[8, 30, 12, 0]],
  ],
  [
    "eve@example.com",
    3,
    "Implement push notifications",
    "Client-side permission prompt",
    [[13, 0, 15, 0]],
  ],
  [
    "eve@example.com",
    0,
    "Implement push notifications",
    "Subscription flow — persistence + re-subscribe",
    [[8, 30, 10, 30]],
  ],

  // ── Product tickets — kira + liam
  ["kira@example.com", 4, "Define MVP feature set", "", [[9, 0, 10, 0]]], // no note
  [
    "kira@example.com",
    4,
    "Define MVP feature set",
    "Final sign-off with stakeholders",
    [[10, 30, 12, 0]],
  ],
  [
    "kira@example.com",
    3,
    "Roadmap Q3 2026",
    "Draft roadmap",
    [
      [9, 0, 12, 0],
      [13, 0, 15, 0],
    ],
  ],
  ["liam@example.com", 3, "Roadmap Q3 2026", "Design capacity estimates", [[9, 30, 11, 0]]],
  [
    "kira@example.com",
    2,
    "Write user stories for time tracking",
    "Story mapping session",
    [[9, 0, 11, 30]],
  ],
  [
    "kira@example.com",
    2,
    "Write user stories for time tracking",
    "AC writeup for timer entries",
    [[13, 0, 14, 30]],
  ],
  [
    "liam@example.com",
    2,
    "Write user stories for time tracking",
    "Review kira's AC — design notes",
    [[14, 30, 16, 0]],
  ],
  ["kira@example.com", 1, "Roadmap Q3 2026", "Stakeholder review — slides", [[9, 30, 12, 0]]],
  [
    "kira@example.com",
    0,
    "Accessibility audit",
    "Screen reader pass on timer page",
    [[9, 0, 11, 0]],
  ],

  // ── Design tickets — liam + carol spotcheck
  [
    "liam@example.com",
    4,
    "Design system token alignment",
    "Audit existing tokens — spreadsheet",
    [[9, 0, 12, 0]],
  ],
  [
    "liam@example.com",
    4,
    "Design system token alignment",
    "Map brand tokens to Tailwind vars",
    [[13, 0, 15, 0]],
  ],
  [
    "liam@example.com",
    3,
    "Timer page mobile mockups",
    "Wireframes — day view + week strip",
    [
      [9, 0, 11, 0],
      [14, 0, 16, 0],
    ],
  ],
  [
    "carol@example.com",
    3,
    "Timer page mobile mockups",
    "Dev review — feasibility notes",
    [[11, 30, 12, 30]],
  ],
  [
    "liam@example.com",
    2,
    "Design system token alignment",
    "Token PR — submit for review",
    [[9, 0, 17, 0]],
  ],
  [
    "liam@example.com",
    1,
    "Timer page mobile mockups",
    "Incorporate dev feedback",
    [[9, 0, 11, 30]],
  ],
  ["liam@example.com", 0, "Onboarding flow illustrations", "Sketch concepts", [[9, 0, 11, 0]]],

  // ── Accounting — frank + grace, multiple entries same ticket same day
  [
    "frank@example.com",
    4,
    "Monthly payroll reconciliation",
    "Import payroll data from ADP",
    [[9, 0, 11, 0]],
  ],
  [
    "frank@example.com",
    4,
    "Monthly payroll reconciliation",
    "Spot-check overtime hours",
    [[13, 0, 15, 0]],
  ],
  [
    "grace@example.com",
    4,
    "Monthly payroll reconciliation",
    "Verify totals against source",
    [[9, 0, 12, 0]],
  ],
  [
    "grace@example.com",
    4,
    "Monthly payroll reconciliation",
    "Escalate 3 discrepancies",
    [[13, 30, 14, 30]],
  ],
  [
    "frank@example.com",
    3,
    "Set up invoice export",
    "Schema design — CSV + PDF targets",
    [[9, 0, 11, 0]],
  ],
  [
    "grace@example.com",
    3,
    "Set up invoice export",
    "Export testing with sample data",
    [[9, 0, 11, 30]],
  ],
  [
    "grace@example.com",
    3,
    "Set up invoice export",
    "Edge case: zero-hour employees",
    [[13, 0, 14, 0]],
  ],
  [
    "frank@example.com",
    2,
    "Monthly payroll reconciliation",
    "Final reconciliation run",
    [[9, 0, 16, 0]],
  ],
  [
    "frank@example.com",
    2,
    "Monthly payroll reconciliation",
    "Submit to payroll provider",
    [[16, 30, 17, 0]],
  ],

  // ── Operations — ian + noah, one shared ticket
  [
    "noah@example.com",
    4,
    "Docker Compose local dev stack",
    "Initial compose file",
    [[9, 0, 12, 0]],
  ],
  [
    "ian@example.com",
    4,
    "Docker Compose local dev stack",
    "MongoDB + Fastify services",
    [[13, 0, 17, 0]],
  ],
  [
    "noah@example.com",
    3,
    "Docker Compose local dev stack",
    "Seed integration — run seed on first boot",
    [[9, 0, 11, 0]],
  ],
  ["ian@example.com", 3, "Docker Compose local dev stack", "", [[11, 30, 14, 0]]], // no note
  [
    "ian@example.com",
    2,
    "Environment rotation script",
    "Draft bash script for env swap",
    [[10, 0, 13, 0]],
  ],
];

const TIMER_SEEDS: TimerSeed[] = THREE_WEEK_OFFSETS.flatMap((weekOffset) =>
  TIMER_SEEDS_BASE.map(([email, daysAgo, ticketTitle, note, sessions]) => [
    email,
    businessDaysAgoToCalendarDays(daysAgo) + weekOffset,
    ticketTitle,
    note,
    sessions,
  ])
);

async function seedTimers(
  userIdsByEmail: Map<string, string>,
  ticketIdsByTitle: Map<string, string>
) {
  for (const [email, daysAgo, ticketTitle, note, sessions] of TIMER_SEEDS) {
    const userId = userIdsByEmail.get(email);
    const ticketId = ticketIdsByTitle.get(ticketTitle);
    if (!userId || !ticketId) continue;
    const date = dateStr(daysAgo);
    const existing = await workItemsCollection().findOne({ userId, ticketId, date, note });
    if (existing) continue;
    const entryId = new ObjectId();
    await workItemsCollection().insertOne({
      _id: entryId,
      userId,
      ticketId,
      date,
      note,
      createdAt: new Date(),
    });
    for (const [startH, startM, endH, endM] of sessions) {
      const startTime = dayMs(daysAgo, startH, startM);
      const endTime = dayMs(daysAgo, endH, endM);
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      await timersCollection().insertOne({
        _id: new ObjectId(),
        workItemId: entryId.toHexString(),
        userId,
        date,
        startTime,
        endTime,
        durationSeconds,
        createdAt: new Date(),
      });
    }
  }
  console.log("✓ Work items + timers seeded");
}

async function seed() {
  await connectDB();

  for (const user of SEED_USERS) {
    try {
      await auth.api.signUpEmail({ body: user });
      console.log(`✓ Created: ${user.email}`);
    } catch (err: any) {
      // Better Auth throws when the email is already taken
      const message: string = err?.message ?? String(err);
      if (message.toLowerCase().includes("already") || message.toLowerCase().includes("exist")) {
        console.log(`- Skipped (exists): ${user.email}`);
      } else {
        console.error(`✗ Failed: ${user.email} —`, message);
      }
    }
  }

  const users = await usersCollection()
    .find({ email: { $in: SEED_USERS.map((u) => u.email) } })
    .toArray();
  const userIdsByEmail = new Map(users.map((u) => [u.email, u._id.toString()]));

  // Assign deterministic usernames to all seeded users except one intentional unclaimed user.
  await usersCollection().bulkWrite(
    SEED_USERS.filter((u) => u.email !== UNCLAIMED_USERNAME_EMAIL).map((u) => ({
      updateOne: {
        filter: { email: u.email },
        update: { $set: { username: u.email.split("@")[0] } },
      },
    }))
  );

  // Explicitly keep one seeded user without a username.
  await usersCollection().updateOne(
    { email: UNCLAIMED_USERNAME_EMAIL },
    { $unset: { username: "" } }
  );

  // Give seeded users a realistic manager/reporting structure for org views.
  await applySeedHierarchy();

  for (const team of SEED_TEAMS) {
    await upsertSeedTeam(team, userIdsByEmail);
  }

  // Build team name → id map for downstream seeders
  const allTeams = await teamsCollection().find({ isPersonal: false }).toArray();
  const teamIdsByName = new Map(allTeams.map((t) => [t.name, t._id.toHexString()]));

  const ticketIdsByTitle = await seedTickets(userIdsByEmail, teamIdsByName);
  await seedClockEvents(userIdsByEmail);
  await seedTimers(userIdsByEmail, ticketIdsByTitle);

  await client.close();
  console.log("Done.");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
