module.exports = {
  async up(db) {
    await db
      .collection("tickets")
      .updateMany(
        { $or: [{ accumulatedTime: { $exists: true } }, { startTimestamp: { $exists: true } }] },
        { $unset: { accumulatedTime: "", startTimestamp: "" } }
      );

    await db
      .collection("clockevents")
      .updateMany({ tickets: { $exists: true } }, { $unset: { tickets: "" } });
  },

  async down() {
    throw new Error("Down migration not supported for 003-remove-legacy-timer-fields");
  },
};
