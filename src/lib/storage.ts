import { mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Document storage.
 *
 * Uploads used to go straight to the local filesystem, which is fine on a server
 * you own and useless on a platform whose disk is discarded between invocations.
 * Everything now goes through this layer: `local` keeps the original behaviour
 * for development, `supabase` puts objects in a private Storage bucket.
 *
 * Configure with:
 *   STORAGE_DRIVER               local (default) | supabase
 *   UPLOAD_DIR                   local driver root (default ./storage/uploads)
 *   SUPABASE_URL                 https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    server-side key; never exposed to the browser
 *   SUPABASE_STORAGE_BUCKET      bucket name (default heimdall-documents)
 *
 * Object keys are the relative paths already stored on each document row, so
 * switching drivers does not invalidate the register — only where the bytes live.
 */

export type StorageDriver = "local" | "supabase";

export function activeDriver(): StorageDriver {
  return (process.env.STORAGE_DRIVER ?? "local").toLowerCase() === "supabase" ? "supabase" : "local";
}

const LOCAL_ROOT = () => path.resolve(process.env.UPLOAD_DIR ?? "./storage/uploads");
const BUCKET = () => process.env.SUPABASE_STORAGE_BUCKET ?? "heimdall-documents";

function supabaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase storage is selected but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.",
    );
  }
  return { url, key };
}

/** Refuses any key that would escape the storage root. */
function safeKey(key: string) {
  const clean = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.split("/").some((seg) => seg === "..")) {
    throw new Error("Invalid storage key.");
  }
  return clean;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const k = safeKey(key);
  if (activeDriver() === "local") {
    const abs = path.resolve(LOCAL_ROOT(), k);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
    return;
  }

  const { url, key: serviceKey } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET()}/${k}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceKey}`,
      "content-type": contentType || "application/octet-stream",
      // Re-uploading the same key replaces it rather than failing, which is what
      // a document version supersede expects.
      "x-upsert": "true",
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    throw new Error(`Storage upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export async function getObject(key: string): Promise<Buffer> {
  const k = safeKey(key);
  if (activeDriver() === "local") {
    const abs = path.resolve(LOCAL_ROOT(), k);
    if (!abs.startsWith(LOCAL_ROOT())) throw new Error("Invalid storage key.");
    return readFile(abs);
  }

  const { url, key: serviceKey } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET()}/${k}`, {
    headers: { authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) {
    throw new Error(`Stored file could not be read (HTTP ${res.status}).`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** True when the object exists. Used to decide whether an artefact needs writing. */
export async function objectExists(key: string): Promise<boolean> {
  const k = safeKey(key);
  if (activeDriver() === "local") {
    return stat(path.resolve(LOCAL_ROOT(), k))
      .then(() => true)
      .catch(() => false);
  }
  try {
    const { url, key: serviceKey } = supabaseConfig();
    const res = await fetch(`${url}/storage/v1/object/info/${BUCKET()}/${k}`, {
      headers: { authorization: `Bearer ${serviceKey}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const k = safeKey(key);
  if (activeDriver() === "local") {
    await unlink(path.resolve(LOCAL_ROOT(), k)).catch(() => undefined);
    return;
  }
  const { url, key: serviceKey } = supabaseConfig();
  await fetch(`${url}/storage/v1/object/${BUCKET()}/${k}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${serviceKey}` },
  }).catch(() => undefined);
}

/** Where objects are going, for an administrator to read on screen. */
export function storageDescription() {
  return activeDriver() === "supabase"
    ? `Supabase Storage bucket "${BUCKET()}"`
    : `local directory ${path.relative(process.cwd(), LOCAL_ROOT()) || "."}`;
}
