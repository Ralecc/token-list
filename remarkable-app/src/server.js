// Local web server for the reMarkable app. No framework — just node:http.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFolder,
  download,
  listEntries,
  loadToken,
  moveEntry,
  pair,
  renameEntry,
  resetClient,
  trashEntry,
  unpair,
  upload,
} from "./rm.js";

const PORT = Number(process.env.PORT ?? 3141);
const HOST = process.env.HOST ?? "127.0.0.1";
const INDEX_HTML = join(dirname(fileURLToPath(import.meta.url)), "public", "index.html");

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req, limit = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 1024 * 1024);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /" || route === "GET /index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(INDEX_HTML));
    return;
  }

  if (route === "GET /api/status") {
    return json(res, 200, { paired: Boolean(await loadToken()) });
  }

  if (route === "POST /api/pair") {
    const { code } = await readJson(req);
    if (!code) return json(res, 400, { error: "Missing one-time code" });
    await pair(code);
    resetClient();
    return json(res, 200, { paired: true });
  }

  if (route === "POST /api/unpair") {
    await unpair();
    resetClient();
    return json(res, 200, { paired: false });
  }

  if (route === "GET /api/items") {
    return json(res, 200, { items: await listEntries() });
  }

  if (route === "POST /api/upload") {
    const name = url.searchParams.get("name");
    if (!name) return json(res, 400, { error: "Missing ?name= query parameter" });
    const body = await readBody(req);
    if (!body.length) return json(res, 400, { error: "Empty upload" });
    const entry = await upload(name, body);
    return json(res, 200, { entry });
  }

  if (route === "GET /api/download") {
    const id = url.searchParams.get("id");
    const hash = url.searchParams.get("hash");
    const name = url.searchParams.get("name") ?? "document";
    if (!id || !hash) return json(res, 400, { error: "Missing ?id= or ?hash=" });
    const { ext, mime, data } = await download(id, hash);
    res.writeHead(200, {
      "content-type": mime,
      "content-disposition": `attachment; filename="${encodeURIComponent(name)}.${ext}"`,
    });
    res.end(Buffer.from(data));
    return;
  }

  if (route === "POST /api/folder") {
    const { name, parent } = await readJson(req);
    if (!name) return json(res, 400, { error: "Missing folder name" });
    return json(res, 200, { entry: await createFolder(name, parent ?? "") });
  }

  if (route === "POST /api/rename") {
    const { hash, name } = await readJson(req);
    if (!hash || !name) return json(res, 400, { error: "Missing hash or name" });
    return json(res, 200, { entry: await renameEntry(hash, name) });
  }

  if (route === "POST /api/move") {
    const { hash, parent } = await readJson(req);
    if (!hash) return json(res, 400, { error: "Missing hash" });
    return json(res, 200, { entry: await moveEntry(hash, parent ?? "") });
  }

  if (route === "POST /api/trash") {
    const { hash } = await readJson(req);
    if (!hash) return json(res, 400, { error: "Missing hash" });
    return json(res, 200, { entry: await trashEntry(hash) });
  }

  json(res, 404, { error: `No such route: ${route}` });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.code === "NOT_PAIRED" ? 401 : 500;
    if (!res.headersSent) json(res, status, { error: err.message ?? String(err) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`reMarkable app running at http://${HOST}:${PORT}`);
  console.log("Pair it with a one-time code from https://my.remarkable.com/device/desktop/connect");
});
