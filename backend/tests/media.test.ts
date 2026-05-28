import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { buildApp } from "../src/server.js";
import { connectDB, client } from "../src/lib/db.js";
import { auth } from "../src/lib/auth.js";
import { mediaItemsCollection, teamsCollection } from "../src/models/index.js";

const TEST_USER = {
  name: "Media Test User",
  email: "media-test-user@test.dev",
  password: "Password1!",
};

const TEAMMATE_USER = {
  name: "Media Teammate User",
  email: "media-teammate-user@test.dev",
  password: "Password1!",
};

const OUTSIDER_USER = {
  name: "Media Outsider User",
  email: "media-outsider-user@test.dev",
  password: "Password1!",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaUploadsDir = path.resolve(__dirname, "../uploads/media");
const thumbnailsDir = path.resolve(__dirname, "../uploads/thumbnails");
const videosDir = path.resolve(
  process.env.TIMEHUDDLE_VIDEOS_DIR?.trim() || path.resolve(__dirname, "../data/videos")
);

let app: FastifyInstance;
let cookie: string;
let userId: string;
let outsiderCookie: string;
let teammateUserId: string;
let outsiderUserId: string;
const SHARED_TEAM_CODE = "MEDIA-AUTH-SHARED";
const SHARED_TEAM_ORG_ID = new ObjectId().toHexString();

async function getSessionCookie(email: string, password: string): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  })) as Response;
  const rawCookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return rawCookies.map((c) => c.split(";")[0].trim()).join("; ");
}

async function purgeUser(email: string) {
  const db = client.db();
  const user = await db.collection("user").findOne({ email });
  if (!user) return;
  const userId = String(user._id);
  await Promise.all([
    db.collection("mediaitems").deleteMany({ userId }),
    db.collection("account").deleteMany({ userId }),
    db.collection("session").deleteMany({ userId }),
    db.collection("user").deleteOne({ _id: user._id }),
  ]);
}

function buildMultipartBody(opts: {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}): { boundary: string; body: Buffer } {
  const boundary = `----timehuddle-test-${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${opts.fieldName}"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, opts.data, tail]) };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await connectDB();
  app = await buildApp({ logger: false });
  await app.ready();

  await purgeUser(TEST_USER.email);
  await purgeUser(TEAMMATE_USER.email);
  await purgeUser(OUTSIDER_USER.email);
  await auth.api.signUpEmail({ body: TEST_USER });
  await auth.api.signUpEmail({ body: TEAMMATE_USER });
  await auth.api.signUpEmail({ body: OUTSIDER_USER });

  const user = await client.db().collection("user").findOne({ email: TEST_USER.email });
  const teammate = await client.db().collection("user").findOne({ email: TEAMMATE_USER.email });
  const outsider = await client.db().collection("user").findOne({ email: OUTSIDER_USER.email });
  if (!user) throw new Error("Failed to create media test user");
  if (!teammate) throw new Error("Failed to create media teammate user");
  if (!outsider) throw new Error("Failed to create media outsider user");

  userId = user._id.toHexString();
  teammateUserId = teammate._id.toHexString();
  outsiderUserId = outsider._id.toHexString();
  cookie = await getSessionCookie(TEST_USER.email, TEST_USER.password);
  outsiderCookie = await getSessionCookie(OUTSIDER_USER.email, OUTSIDER_USER.password);

  await teamsCollection().deleteOne({ code: SHARED_TEAM_CODE });
  await teamsCollection().insertOne({
    _id: new ObjectId(),
    orgId: SHARED_TEAM_ORG_ID,
    name: "Media Shared Team",
    members: [userId, teammateUserId],
    admins: [userId],
    code: SHARED_TEAM_CODE,
    isPersonal: false,
    createdAt: new Date(),
  });
}, 20000);

afterAll(async () => {
  await mediaItemsCollection().deleteMany({
    userId: { $in: [userId, teammateUserId, outsiderUserId] },
  });
  await teamsCollection().deleteOne({ code: SHARED_TEAM_CODE });
  await purgeUser(TEST_USER.email);
  await purgeUser(TEAMMATE_USER.email);
  await purgeUser(OUTSIDER_USER.email);
  await app.close();
});

describe("media routes", () => {
  it("clamps list limit to 100 items", async () => {
    await mediaItemsCollection().deleteMany({ userId });

    const docs = Array.from({ length: 120 }, (_, idx) => ({
      _id: new ObjectId(),
      userId,
      type: "image" as const,
      mimeType: "image/png",
      url: `/uploads/media/limit-${idx}.png`,
      filename: `limit-${idx}.png`,
      size: 100 + idx,
      uploadedAt: new Date(Date.now() - idx * 1000),
    }));

    await mediaItemsCollection().insertMany(docs);

    const res = await app.inject({
      method: "GET",
      url: "/v1/media?limit=9999",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(100);
  });

  it("rejects thumbnail uploads with unsupported mime type", async () => {
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId,
      type: "video",
      mimeType: "video/mp4",
      url: "http://localhost:4000/v1/video/test-video-id",
      videoid: "test-video-id",
      filename: "test-video.mp4",
      size: 1234,
      uploadedAt: new Date(),
    });

    const { boundary, body } = buildMultipartBody({
      fieldName: "file",
      filename: "thumb.txt",
      contentType: "text/plain",
      data: Buffer.from("not-an-image"),
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${docId.toHexString()}/thumbnail`,
      headers: {
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Unsupported thumbnail type");
  });

  it("replaces local thumbnail and removes old thumbnail file", async () => {
    const oldThumbName = `old-thumb-${Date.now()}.jpg`;
    const oldThumbPath = path.join(thumbnailsDir, oldThumbName);
    await fs.mkdir(thumbnailsDir, { recursive: true });
    await fs.writeFile(oldThumbPath, Buffer.from("old-thumb"));

    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId,
      type: "video",
      mimeType: "video/mp4",
      url: "http://localhost:4000/v1/video/replace-thumb-test",
      videoid: "replace-thumb-test",
      filename: "replace-thumb-test.mp4",
      size: 2222,
      thumbnail: `/uploads/thumbnails/${oldThumbName}`,
      uploadedAt: new Date(),
    });

    const { boundary, body } = buildMultipartBody({
      fieldName: "file",
      filename: "thumb.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("new-thumb"),
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${docId.toHexString()}/thumbnail`,
      headers: {
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(await exists(oldThumbPath)).toBe(false);

    const nextThumbnailUrl = res.json().item.thumbnail as string;
    expect(nextThumbnailUrl).toMatch(/^\/uploads\/thumbnails\//);
    expect(nextThumbnailUrl).not.toBe(`/uploads/thumbnails/${oldThumbName}`);

    const nextThumbName = path.basename(nextThumbnailUrl);
    const nextThumbPath = path.join(thumbnailsDir, nextThumbName);
    expect(await exists(nextThumbPath)).toBe(true);

    // Keep test runs tidy: remove the newly created thumbnail file.
    await fs.unlink(nextThumbPath).catch(() => {});
  });

  it("deletes local files when media item is deleted", async () => {
    const imageName = `delete-test-${Date.now()}.png`;
    const thumbName = `delete-test-${Date.now()}.jpg`;
    const videoid = `delete-video-${Date.now()}`;

    const imagePath = path.join(mediaUploadsDir, imageName);
    const thumbPath = path.join(thumbnailsDir, thumbName);
    const videoPath = path.join(videosDir, videoid);

    await fs.mkdir(mediaUploadsDir, { recursive: true });
    await fs.mkdir(thumbnailsDir, { recursive: true });
    await fs.mkdir(videoPath, { recursive: true });

    await fs.writeFile(imagePath, Buffer.from("img"));
    await fs.writeFile(thumbPath, Buffer.from("thumb"));
    await fs.writeFile(path.join(videoPath, "video.mp4"), Buffer.from("video"));

    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId,
      type: "video",
      mimeType: "video/mp4",
      url: `/uploads/media/${imageName}`,
      videoid,
      filename: "source.mp4",
      size: 9876,
      thumbnail: `/uploads/thumbnails/${thumbName}`,
      uploadedAt: new Date(),
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/media/${docId.toHexString()}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(await exists(imagePath)).toBe(false);
    expect(await exists(thumbPath)).toBe(false);
    expect(await exists(videoPath)).toBe(false);
  });

  it("forbids updating another user's media item", async () => {
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId: teammateUserId,
      type: "image",
      mimeType: "image/png",
      url: "/uploads/media/teammate-image.png",
      filename: "teammate-image.png",
      size: 500,
      uploadedAt: new Date(),
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/v1/media/${docId.toHexString()}`,
      headers: { cookie },
      payload: { title: "Nope" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Forbidden");
  });

  it("forbids deleting another user's media item", async () => {
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId: teammateUserId,
      type: "image",
      mimeType: "image/png",
      url: "/uploads/media/teammate-delete.png",
      filename: "teammate-delete.png",
      size: 600,
      uploadedAt: new Date(),
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/media/${docId.toHexString()}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Forbidden");
  });

  it("allows listing a teammate's media when users share a team", async () => {
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId: teammateUserId,
      type: "image",
      mimeType: "image/png",
      url: "/uploads/media/shared-team-image.png",
      filename: "shared-team-image.png",
      size: 700,
      uploadedAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/media/user/${teammateUserId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
    expect(res.json().items.some((item: { id: string }) => item.id === docId.toHexString())).toBe(
      true
    );
  });

  it("forbids listing another user's media without a shared team", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/media/user/${teammateUserId}`,
      headers: { cookie: outsiderCookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Forbidden");
  });

  it("requires auth for PulseVault resolve playback", async () => {
    const videoid = randomUUID();
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId,
      type: "video",
      mimeType: "video/mp4",
      url: `http://localhost:4000/v1/video/${videoid}`,
      videoid,
      filename: "resolve-auth.mp4",
      size: 321,
      uploadedAt: new Date(),
    });

    const res = await app.inject({ method: "GET", url: `/v1/video/${videoid}` });
    expect(res.statusCode).toBe(401);
  });

  it("enforces shared-team gating for PulseVault media playback", async () => {
    const videoid = randomUUID();
    const docId = new ObjectId();
    await mediaItemsCollection().insertOne({
      _id: docId,
      userId: teammateUserId,
      type: "video",
      mimeType: "video/mp4",
      url: `http://localhost:4000/v1/video/${videoid}`,
      videoid,
      filename: "resolve-shared.mp4",
      size: 654,
      uploadedAt: new Date(),
    });

    const forbiddenRes = await app.inject({
      method: "GET",
      url: `/v1/video/${videoid}`,
      headers: { cookie: outsiderCookie },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const teammateRes = await app.inject({
      method: "GET",
      url: `/v1/video/${videoid}`,
      headers: { cookie },
    });
    // Authorized viewer reaches storage resolution path (often 404 in tests due to no file).
    expect(teammateRes.statusCode).not.toBe(401);
    expect(teammateRes.statusCode).not.toBe(403);
  });
});
