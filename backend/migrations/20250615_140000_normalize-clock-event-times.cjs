module.exports = {
  async up(db) {
    const coll = db.collection("clockevents");

    await coll.updateMany({ startTimestamp: { $exists: true }, startTime: { $exists: false } }, [
      { $set: { startTime: "$startTimestamp" } },
      { $unset: "startTimestamp" },
    ]);

    const cursor = coll.find({ endTime: { $type: "date" } });
    for await (const doc of cursor) {
      const ms = doc.endTime.getTime();
      await coll.updateOne({ _id: doc._id }, { $set: { endTime: ms } });
    }
  },

  async down() {
    throw new Error("Down migration not supported for 001-normalize-clock-event-times");
  },
};
