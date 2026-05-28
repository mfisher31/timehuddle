import { getDB } from "./db.js";

export async function ensureIndexes() {
  const db = getDB();

  const profiles = db.collection("profiles");
  await profiles.createIndex({ userId: 1, app: 1 }, { unique: true });

  // ── WorkItem indexes ───────────────────────────────────────────────────────
  // Ensure collection exists before reading indexes (fresh DBs have no namespace yet).
  await db.createCollection("workitems").catch((err: unknown) => {
    if ((err as { code?: number }).code !== 48) throw err; // NamespaceExists
  });
  const workItems = db.collection("workitems");
  // 1. Lookup index for user × ticket × day (duplicates are allowed)
  const workItemIndexes = await workItems.indexes();
  const legacyNaturalKey = workItemIndexes.find(
    (idx) =>
      idx.unique === true && idx.key?.userId === 1 && idx.key?.ticketId === 1 && idx.key?.date === 1
  );
  if (legacyNaturalKey?.name) {
    await workItems.dropIndex(legacyNaturalKey.name);
  }
  await workItems.createIndex({ userId: 1, ticketId: 1, date: 1 });
  // 2. Day view — all work items for a user on a given UTC date
  await workItems.createIndex({ userId: 1, date: 1 });

  // ── Timer indexes ───────────────────────────────────────────────────────────
  const timers = db.collection("timers");
  // 3. At most one running timer per user (unique partial index)
  await timers.createIndex(
    { userId: 1 },
    { unique: true, partialFilterExpression: { endTime: null }, name: "one_running_per_user" }
  );
  // 4. Timers within a WorkItem, ordered by start time
  await timers.createIndex({ workItemId: 1, startTime: 1 });
  // 5. Timers for a user on a given UTC date
  await timers.createIndex({ userId: 1, date: 1 });

  // ── Clock event indexes ─────────────────────────────────────────────────────
  const clockEvents = db.collection("clockevents");
  await clockEvents.createIndex({ userId: 1, endTime: 1 });

  // ── Clock break indexes ─────────────────────────────────────────────────────
  const clockBreaks = db.collection("clockbreaks");
  // Open-break lookup (isPaused check): find the one open break for an event fast
  await clockBreaks.createIndex({ clockEventId: 1, endTime: 1 });
  // Ordered retrieval of all breaks for an event
  await clockBreaks.createIndex({ clockEventId: 1, startTime: 1 });
  // Prevent concurrent pause from creating multiple open breaks per event
  await clockBreaks.createIndex(
    { clockEventId: 1 },
    { unique: true, partialFilterExpression: { endTime: null }, name: "one_open_break_per_event" }
  );

  // Personal access tokens
  const pats = db.collection("personal_access_tokens");
  await pats.createIndex({ tokenHash: 1 }, { unique: true });
  await pats.createIndex({ userId: 1 });

  console.log("MongoDB indexes ensured");
}
