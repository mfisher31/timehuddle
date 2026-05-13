import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { connectDB, getDB } from "../src/lib/db.js";

// Load migrate-mongo migration modules
const m001 = require("../migrations/20250615_140000_normalize-clock-event-times.cjs");
const m002 = require("../migrations/20250615_140100_activity-log-index.cjs");
const m003 = require("../migrations/20250615_140200_remove-legacy-timer-fields.cjs");

beforeAll(async () => {
  await connectDB();
});

afterAll(async () => {
  await getDB()
    .collection("_migration_test_clock")
    .drop()
    .catch(() => {});
  await getDB()
    .collection("_migration_test_activities")
    .drop()
    .catch(() => {});
  await getDB()
    .collection("_migration_test_tickets")
    .drop()
    .catch(() => {});
});

describe("migrate-mongo migrations", () => {
  describe("001-normalize-clock-event-times", () => {
    let testDb: ReturnType<typeof getDB>;

    beforeEach(async () => {
      testDb = getDB();
      await testDb.collection("clockevents").deleteMany({});
    });

    it("renames startTimestamp → startTime", async () => {
      const coll = testDb.collection("clockevents");
      await coll.insertOne({
        _id: new ObjectId(),
        startTimestamp: 1_700_000_000_000,
        endTime: null,
      });

      await m001.up(testDb);

      const doc = await coll.findOne({});
      expect(doc!.startTime).toBe(1_700_000_000_000);
      expect(doc!.startTimestamp).toBeUndefined();
    });

    it("converts endTime Date → epoch ms number", async () => {
      const coll = testDb.collection("clockevents");
      const date = new Date("2024-01-15T10:30:00Z");
      const { insertedId } = await coll.insertOne({
        _id: new ObjectId(),
        startTime: 1_700_000_000_002,
        endTime: date,
      });

      await m001.up(testDb);

      const doc = await coll.findOne({ _id: insertedId });
      expect(typeof doc!.endTime).toBe("number");
      expect(doc!.endTime).toBe(date.getTime());
    });

    it("leaves endTime: null untouched", async () => {
      const coll = testDb.collection("clockevents");
      const { insertedId } = await coll.insertOne({
        _id: new ObjectId(),
        startTime: 1_700_000_000_003,
        endTime: null,
      });

      await m001.up(testDb);

      const doc = await coll.findOne({ _id: insertedId });
      expect(doc!.endTime).toBeNull();
    });

    it("is idempotent — safe to run twice", async () => {
      const coll = testDb.collection("clockevents");
      const date = new Date("2024-06-01T08:00:00Z");
      const { insertedId } = await coll.insertOne({
        _id: new ObjectId(),
        startTimestamp: 1_710_000_000_000,
        endTime: date,
      });

      await m001.up(testDb);
      await m001.up(testDb);

      const doc = await coll.findOne({ _id: insertedId });
      expect(doc!.startTime).toBe(1_710_000_000_000);
      expect(doc!.startTimestamp).toBeUndefined();
      expect(doc!.endTime).toBe(date.getTime());
    });
  });

  describe("002-activity-log-index", () => {
    let testDb: ReturnType<typeof getDB>;

    beforeEach(async () => {
      testDb = getDB();
      await testDb
        .collection("activities")
        .dropIndexes()
        .catch(() => {});
    });

    it("creates compound index on activities", async () => {
      await m002.up(testDb);

      const indexes = await testDb.collection("activities").listIndexes().toArray();
      const compoundIndex = indexes.find(
        (idx) => idx.key.userId === 1 && idx.key.occurredAt === -1
      );
      expect(compoundIndex).toBeDefined();
    });

    it("can drop the index", async () => {
      await m002.up(testDb);
      await m002.down(testDb);

      const indexes = await testDb.collection("activities").listIndexes().toArray();
      const compoundIndex = indexes.find(
        (idx) => idx.key.userId === 1 && idx.key.occurredAt === -1
      );
      expect(compoundIndex).toBeUndefined();
    });
  });

  describe("003-remove-legacy-timer-fields", () => {
    let testDb: ReturnType<typeof getDB>;

    beforeEach(async () => {
      testDb = getDB();
      await testDb.collection("tickets").deleteMany({});
      await testDb.collection("clockevents").deleteMany({});
    });

    it("removes accumulatedTime and startTimestamp from tickets", async () => {
      const ticketsColl = testDb.collection("tickets");
      const { insertedId } = await ticketsColl.insertOne({
        _id: new ObjectId(),
        accumulatedTime: 3600,
        startTimestamp: 1_700_000_000_000,
        title: "Test ticket",
      });

      await m003.up(testDb);

      const doc = await ticketsColl.findOne({ _id: insertedId });
      expect(doc!.accumulatedTime).toBeUndefined();
      expect(doc!.startTimestamp).toBeUndefined();
      expect(doc!.title).toBe("Test ticket");
    });

    it("removes tickets[] from clockevents", async () => {
      const clockColl = testDb.collection("clockevents");
      const { insertedId } = await clockColl.insertOne({
        _id: new ObjectId(),
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_003_600_000,
        tickets: ["ticket1", "ticket2"],
      });

      await m003.up(testDb);

      const doc = await clockColl.findOne({ _id: insertedId });
      expect(doc!.tickets).toBeUndefined();
      expect(doc!.startTime).toBe(1_700_000_000_000);
    });

    it("is idempotent — safe to run twice", async () => {
      const ticketsColl = testDb.collection("tickets");
      const { insertedId } = await ticketsColl.insertOne({
        _id: new ObjectId(),
        accumulatedTime: 3600,
        title: "Test ticket",
      });

      await m003.up(testDb);
      await m003.up(testDb);

      const doc = await ticketsColl.findOne({ _id: insertedId });
      expect(doc!.accumulatedTime).toBeUndefined();
      expect(doc!.title).toBe("Test ticket");
    });
  });
});
