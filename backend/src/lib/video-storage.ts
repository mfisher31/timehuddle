import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getVideoStorageDir(): string {
  const configured = process.env.TIMEHUDDLE_VIDEOS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(__dirname, "../../data/videos");
}
