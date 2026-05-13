require("dotenv").config();

const DEFAULT_DB_NAME = "timeharbor";

function inferDatabaseNameFromUri(uri) {
  if (!uri) return DEFAULT_DB_NAME;

  const withoutParams = uri.split("?")[0];
  const lastSlash = withoutParams.lastIndexOf("/");
  if (lastSlash < 0 || lastSlash === withoutParams.length - 1) {
    return DEFAULT_DB_NAME;
  }

  return withoutParams.slice(lastSlash + 1);
}

module.exports = {
  mongodb: {
    url: process.env.MONGODB_URI,
    databaseName:
      process.env.MIGRATE_MONGO_DB_NAME || inferDatabaseNameFromUri(process.env.MONGODB_URI),
    options: {},
  },

  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  migrationFileExtension: ".cjs",
  useFileHash: false,
  moduleSystem: "commonjs",
};
