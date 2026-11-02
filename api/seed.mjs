#!/usr/bin/env node
// Seed script: loads properties.js into the table and creates the logins.
//
// Usage (names come from infra/config.sh):
//   node api/seed.mjs            # writes to DynamoDB
//   node api/seed.mjs --dry-run  # prints only
//
// Reads ../properties.js (a plain <script> file that sets window.PROPERTIES)
// by evaluating it in a sandboxed vm context with a fake `window`, then
// BatchWrites every property as a PROP#<id>/META item. Also creates the three
// USER# items (alex, sam, guest), each with its own random password, printed
// once at the end. Write them down; change one later with api/add-user.mjs.
//
// Idempotent: re-running writes the same PROP items (deterministic mapping,
// no timestamps), and skips USER# items that already exist rather than
// clobbering their salt/hash (which would invalidate nothing functionally,
// but there's no reason to touch them on every run).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
// AWS SDK modules are imported lazily (inside main(), after the --dry-run
// short-circuit) so `--dry-run` works even in an environment that doesn't
// have them installed locally (e.g. verifying this script without AWS creds
// or `npm install`).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { TABLE, REGION } from "./local-config.mjs";
const DRY_RUN = process.argv.includes("--dry-run");

// Must match VALID_USERS in api/index.mjs and USERS in web/app.js.
const USERS = [
  { id: "alex", name: "Alex" },
  { id: "sam", name: "Sam" },
  { id: "guest", name: "Invité" },
];

// No password ships with the code: anyone can read a default in a public
// repo. Each login gets a fresh one, e.g. "maple-river-42-stone".
const WORDS = ("amber anchor apple arrow aspen basil birch bloom brook cedar cliff clover coral " +
  "dune ember fern field flint frost grove harbor hazel heron ivy juniper lark linen " +
  "maple meadow mint moss oak olive orchid pebble pine plum quartz reed ridge river " +
  "sage shore slate sparrow spruce stone thyme tide timber tulip valley willow wren").split(" ");
function newPassword() {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${w()}-${crypto.randomInt(10, 100)}-${w()}`;
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + password, "utf8").digest("hex");
}

// --- load properties.js -----------------------------------------------------

function loadProperties() {
  const propsPath = path.resolve(__dirname, "..", "web", "properties.js");
  const src = fs.readFileSync(propsPath, "utf8");
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: propsPath });
  const list = sandbox.window.PROPERTIES;
  if (!Array.isArray(list)) {
    throw new Error("properties.js did not set window.PROPERTIES to an array");
  }
  return list;
}

// Derive `kind` from `type` (Terrain -> land, everything else -> property).
function deriveKind(type) {
  return type === "Terrain" ? "land" : "property";
}

// Derive `town` from the trailing commune name in a French address like
// "33000 Bordeaux" or "9 Rue Georges Lehmann, 33000 Bordeaux".
function deriveTown(address) {
  if (!address || typeof address !== "string") return null;
  const m = address.match(/\b\d{5}\s+(.+)$/);
  if (m) return m[1].trim();
  return null;
}

function toPropItem(p) {
  if (!p.id) throw new Error(`property missing id: ${JSON.stringify(p)}`);
  return {
    pk: `PROP#${p.id}`,
    sk: "META",
    name: p.name ?? null,
    address: p.address ?? null,
    town: p.town || deriveTown(p.address),
    kind: p.kind || deriveKind(p.type),
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    price: p.price ?? null,
    surface: p.surface ?? null,
    rooms: p.rooms ?? null,
    chambres: p.chambres ?? null,
    terrain: p.terrain ?? null,
    type: p.type ?? null,
    photo: p.photo ?? null,
    street: p.street ?? null,
    url: p.url ?? null,
    note: p.note ?? "",
    listing: p.listing ?? null,
    geo: p.geo ?? null,
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchWriteAll(ddb, sdk, items) {
  const { BatchWriteCommand } = sdk;
  for (const batch of chunk(items, 25)) {
    let requestItems = {
      [TABLE]: batch.map((Item) => ({ PutRequest: { Item } })),
    };
    // Retry unprocessed items with simple backoff — table is tiny, this
    // should essentially never loop more than once.
    let attempt = 0;
    while (requestItems[TABLE].length) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = res.UnprocessedItems?.[TABLE] || [];
      if (!unprocessed.length) break;
      attempt += 1;
      if (attempt > 5) throw new Error("too many retries on BatchWrite unprocessed items");
      await new Promise((r) => setTimeout(r, 200 * attempt));
      requestItems = { [TABLE]: unprocessed };
    }
  }
}

async function upsertUsers(ddb, sdk) {
  const created = [];
  for (const u of USERS) {
    const key = { pk: `USER#${u.id}`, sk: "USER" };
    if (DRY_RUN) {
      console.log(`[dry-run] would upsert USER#${u.id} (skip-if-exists) name=${u.name}`);
      continue;
    }
    const { GetCommand, PutCommand } = sdk;
    const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
    if (existing.Item) {
      console.log(`USER#${u.id} already exists — leaving password untouched`);
      continue;
    }
    const password = newPassword();
    const salt = crypto.randomBytes(16).toString("hex");
    const passHash = hashPassword(password, salt);
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...key, name: u.name, salt, passHash },
      })
    );
    created.push([u.id, password]);
  }
  if (created.length) {
    console.log("\nLogins created — note these passwords now, they are not stored anywhere:");
    for (const [id, pw] of created) console.log(`  ${id.padEnd(6)} ${pw}`);
    console.log("");
  }
}

async function main() {
  const properties = loadProperties();
  console.log(`Loaded ${properties.length} properties from properties.js`);

  const items = properties.map(toPropItem);

  const kindCounts = items.reduce((acc, i) => {
    acc[i.kind] = (acc[i.kind] || 0) + 1;
    return acc;
  }, {});
  console.log("kind breakdown:", kindCounts);

  if (DRY_RUN) {
    console.log(`[dry-run] would write ${items.length} PROP items to ${TABLE}`);
    console.log("[dry-run] sample item:", JSON.stringify(items[0], null, 2));
    console.log(
      `[dry-run] sample land item:`,
      JSON.stringify(items.find((i) => i.kind === "land"), null, 2)
    );
    await upsertUsers(null, null);
    console.log("[dry-run] no writes performed.");
    return;
  }

  // Import the AWS SDK lazily so --dry-run works without it installed.
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const libDdb = await import("@aws-sdk/lib-dynamodb");
  const { DynamoDBDocumentClient } = libDdb;

  const ddbClient = new DynamoDBClient({ region: REGION });
  const ddb = DynamoDBDocumentClient.from(ddbClient);

  await batchWriteAll(ddb, libDdb, items);
  console.log(`Wrote ${items.length} PROP items to ${TABLE}`);

  await upsertUsers(ddb, libDdb);

  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
