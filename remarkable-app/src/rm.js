// Thin wrapper around rmapi-js: device-token persistence + a shared client.
//
// Pairing model (reMarkable cloud):
//   1. The user gets a one-time code from https://my.remarkable.com/device/desktop/connect
//   2. register(code) exchanges it for a long-lived device token
//   3. The device token is persisted locally and reused to open API sessions
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { register, remarkable } from "./vendor.js";

const CONFIG_DIR = process.env.RMK_CONFIG_DIR ?? join(homedir(), ".remarkable-app");
const TOKEN_FILE = join(CONFIG_DIR, "device-token");

export async function loadToken() {
  try {
    return (await readFile(TOKEN_FILE, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function pair(code) {
  const token = await register(code.trim());
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export async function unpair() {
  await rm(TOKEN_FILE, { force: true });
}

let clientPromise = null;

/** Get a shared API client, or throw if the device isn't paired yet. */
export function getClient() {
  clientPromise ??= (async () => {
    const token = await loadToken();
    if (!token) {
      const err = new Error(
        "Not paired with the reMarkable cloud yet. Get a one-time code from " +
          "https://my.remarkable.com/device/desktop/connect and run pairing first.",
      );
      err.code = "NOT_PAIRED";
      throw err;
    }
    return await remarkable(token);
  })();
  // Let a failed session attempt be retried on the next call.
  clientPromise.catch(() => {
    clientPromise = null;
  });
  return clientPromise;
}

export function resetClient() {
  clientPromise = null;
}

/** List all entries, normalized for transport to the UI / CLI. */
export async function listEntries() {
  const api = await getClient();
  const items = await api.listItems();
  return items.map((e) => ({
    id: e.id,
    hash: e.hash,
    type: e.type === "CollectionType" ? "folder" : "document",
    name: e.visibleName,
    parent: e.parent ?? "",
    lastModified: e.lastModified,
    pinned: e.pinned ?? false,
  }));
}

/** Upload a PDF or EPUB buffer; format decided by file extension. */
export async function upload(fileName, buffer) {
  const api = await getClient();
  const name = fileName.replace(/\.(pdf|epub)$/i, "");
  const bytes = new Uint8Array(buffer);
  if (/\.epub$/i.test(fileName)) return await api.uploadEpub(name, bytes);
  if (/\.pdf$/i.test(fileName)) return await api.uploadPdf(name, bytes);
  throw new Error(`Unsupported file type: ${fileName} (only .pdf and .epub can be uploaded)`);
}

/**
 * Download a document's content. Tries PDF, then EPUB, then falls back to the
 * raw document archive (.rmdoc) for notebooks.
 */
export async function download(id, hash) {
  const api = await getClient();
  try {
    return { ext: "pdf", mime: "application/pdf", data: await api.getPdf(id, hash) };
  } catch {
    /* not a pdf */
  }
  try {
    return { ext: "epub", mime: "application/epub+zip", data: await api.getEpub(id, hash) };
  } catch {
    /* not an epub */
  }
  return { ext: "rmdoc", mime: "application/zip", data: await api.getDocument(id, hash) };
}

export async function createFolder(name, parent = "") {
  const api = await getClient();
  const entry = await api.uploadFolder(name);
  if (parent) await api.move(entry.hash, parent);
  return entry;
}

export async function renameEntry(hash, name) {
  const api = await getClient();
  return await api.rename(hash, name);
}

export async function moveEntry(hash, parent) {
  const api = await getClient();
  return await api.move(hash, parent);
}

export async function trashEntry(hash) {
  const api = await getClient();
  // "trash" is a special parent id — this moves the entry to trash rather
  // than deleting it outright, matching what the tablet UI does.
  return await api.move(hash, "trash");
}
