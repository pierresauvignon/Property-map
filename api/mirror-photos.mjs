// Mirror every listing photo into S3 so the app never hotlinks the portals.
// Listings get taken down and the images go with
// them; once mirrored, the photos outlive the advert.
//
//   node api/mirror-photos.mjs [--dry-run]
import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

import { REGION, TABLE, UPLOADS_BUCKET as BUCKET } from "./local-config.mjs";
// Served from the app's own origin, so only ever store a picture.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const dry = process.argv.includes("--dry-run");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

const props = [];
let key;
do {
  const r = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: key }));
  r.Items.filter((i) => i.sk === "META").forEach((i) => props.push(i));
  key = r.LastEvaluatedKey;
} while (key);

const todo = props.filter((p) => Array.isArray(p.gallery) && p.gallery.some((u) => /^https?:/i.test(u)));
console.log(`${props.length} properties, ${todo.length} with remote photos`);

let done = 0, copied = 0, failed = 0, bytes = 0;
for (const p of todo) {
  const id = p.pk.replace("PROP#", "");
  const out = [];
  for (const url of p.gallery) {
    if (!/^https?:/i.test(url)) { out.push(url); continue; }      // already mirrored
    const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    const objKey = `photos/${id}/${hash}.jpg`;
    const path = `/${objKey}`;
    if (dry) { out.push(path); copied++; continue; }
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: objKey }));
      out.push(path); copied++; continue;                          // already there
    } catch (_) { /* not uploaded yet */ }
    try {
      const r = await fetch(url, { redirect: "error" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) throw new Error("not an image: " + type);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) throw new Error("suspiciously small");
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: objKey, Body: buf,
        ContentType: type,
        CacheControl: "public, max-age=31536000, immutable",
      }));
      bytes += buf.length; copied++;
      out.push(path);
    } catch (e) {
      failed++;
      out.push(url);                                               // keep the original
      console.warn(`  ! ${id} ${String(e.message).slice(0, 40)}`);
    }
  }
  if (!dry) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: p.pk, sk: "META" },
      UpdateExpression: "SET gallery = :g, photo = :h, updatedAt = :t",
      ExpressionAttributeValues: { ":g": out, ":h": out[0], ":t": Date.now() },
    }));
  }
  done++;
  process.stdout.write(`\r  ${done}/${todo.length} properties, ${copied} photos`);
}
console.log(`\n${dry ? "[dry-run] " : ""}${copied} photos, ${failed} failed, ${(bytes/1048576).toFixed(1)} MB`);
