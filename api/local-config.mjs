// For the scripts run from your machine (seed, add-user, mirror-photos): reads
// the same infra/config.sh the deploy scripts use, so names live in one place.
// Environment variables win, which is handy for a second table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "infra", "config.sh");
const vars = {};
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=("([^"]*)"|'([^']*)'|[^\s#]*)/);
    if (m) vars[m[1]] = m[3] ?? m[4] ?? m[2];
  }
}
const get = (k) => process.env[k] || vars[k] || "";

if (!process.env.AWS_PROFILE && vars.AWS_PROFILE) process.env.AWS_PROFILE = vars.AWS_PROFILE;
export const REGION = get("AWS_REGION") || vars.REGION || "us-east-1";
export const TABLE = get("TABLE_NAME") || vars.NAME;
export const UPLOADS_BUCKET = get("UPLOAD_BUCKET") || (vars.BUCKET_PREFIX ? `${vars.BUCKET_PREFIX}-uploads` : "");

if (!TABLE) {
  console.error("No table name: create infra/config.sh (see infra/config.example.sh) or set TABLE_NAME.");
  process.exit(1);
}
