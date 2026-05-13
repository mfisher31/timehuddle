import { MongoClient } from "mongodb";

const LEGACY_COLLECTION = "_migrations";
const CHANGELOG_COLLECTION = "changelog";

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const db = client.db();
    const legacy = db.collection(LEGACY_COLLECTION);
    const changelog = db.collection(CHANGELOG_COLLECTION);

    const legacyRows = await legacy.find().toArray();
    const existing = new Set(
      (await changelog.find({}, { projection: { fileName: 1 } }).toArray()).map((doc) =>
        String(doc.fileName)
      )
    );

    // Map legacy migration names to new timestamp-based filenames
    const nameToFileName: Record<string, string> = {
      "001-normalize-clock-event-times": "20250615_140000_normalize-clock-event-times.cjs",
      "002-activity-log-index": "20250615_140100_activity-log-index.cjs",
      "003-remove-legacy-timer-fields": "20250615_140200_remove-legacy-timer-fields.cjs",
    };

    let inserted = 0;
    for (const row of legacyRows) {
      const fileName = nameToFileName[row.name] || `${row.name}.cjs`;
      if (existing.has(fileName)) continue;

      await changelog.insertOne({
        fileName,
        appliedAt: row.appliedAt ?? new Date(),
      });
      inserted++;
    }

    console.log(`Synced ${inserted} migration record(s) into '${CHANGELOG_COLLECTION}'.`);
  } finally {
    await client.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
