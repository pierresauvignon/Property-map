/* One-off: create (or re-password) a login.
 *
 *   node api/add-user.mjs <id> "<name>" <password> [--email=you@example.com] [--force]
 *
 * With --email, that login gets notification mail (when MAIL_FROM is set).
 *
 * The id must be one of VALID_USERS in api/index.mjs.
 *
 * Writes USER#<id> with a fresh 16-byte salt and sha256(salt + password),
 * which is exactly what the Lambda's login route verifies against. Refuses
 * to touch an existing user unless --force is passed, so a typo cannot lock
 * one of us out.
 */
import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { TABLE, REGION } from "./local-config.mjs";

const [, , idRaw, name, password] = process.argv;
const force = process.argv.includes("--force");
const email = (process.argv.find((a) => a.startsWith("--email=")) || "").slice("--email=".length);
if (!idRaw || !name || !password) {
  console.error('usage: node api/add-user.mjs <id> "<name>" <password> [--force]');
  process.exit(1);
}
const id = idRaw.trim().toLowerCase();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const key = { pk: `USER#${id}`, sk: "USER" };

const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
if (existing.Item && !force) {
  console.error(`USER#${id} already exists — pass --force to reset its password`);
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString("hex");
const passHash = crypto.createHash("sha256").update(salt + password, "utf8").digest("hex");
await ddb.send(new PutCommand({
  TableName: TABLE,
  Item: { ...existing.Item, ...key, name, salt, passHash, ...(email ? { email } : {}) },
}));
console.log(`${existing.Item ? "reset" : "created"} USER#${id} (${name})`);
