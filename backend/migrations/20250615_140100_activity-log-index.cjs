const INDEX_NAME = "userId_1_occurredAt_-1";

module.exports = {
  async up(db) {
    await db.collection("activities").createIndex({ userId: 1, occurredAt: -1 }, { background: true });
  },

  async down(db) {
    await db.collection("activities").dropIndex(INDEX_NAME).catch(() => {});
  },
};
