#!/usr/bin/env node
// Command-line interface for the reMarkable cloud.
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  createFolder,
  download,
  listEntries,
  moveEntry,
  pair,
  renameEntry,
  trashEntry,
  upload,
} from "./rm.js";

const USAGE = `rmk — talk to your reMarkable tablet from the terminal

Usage:
  rmk pair <one-time-code>        Pair using a code from my.remarkable.com/device/desktop/connect
  rmk ls [folder]                 List files (optionally inside a folder, by name or id)
  rmk tree                        Show the whole folder tree
  rmk upload <file.pdf|.epub> [folder]   Send a document to the tablet
  rmk download <name|id> [out]    Download a document (PDF/EPUB/notebook)
  rmk mkdir <name> [parent]       Create a folder
  rmk mv <name|id> <folder|/>     Move a document/folder ("/" = root)
  rmk rename <name|id> <new name> Rename a document/folder
  rmk trash <name|id>             Move a document/folder to trash
`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function findEntry(ref, { folders = false } = {}) {
  const items = await listEntries();
  const active = items.filter((i) => i.parent !== "trash");
  const match =
    active.find((i) => i.id === ref) ??
    active.find((i) => i.name === ref && (!folders || i.type === "folder")) ??
    active.find((i) => i.name.toLowerCase() === ref.toLowerCase() && (!folders || i.type === "folder"));
  if (!match) fail(`No ${folders ? "folder" : "entry"} matching "${ref}" found.`);
  return match;
}

const icon = (i) => (i.type === "folder" ? "📁" : "📄");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "pair": {
      if (!args[0]) fail("Usage: rmk pair <one-time-code>");
      await pair(args[0]);
      console.log("Paired. Try `rmk ls`.");
      break;
    }

    case "ls": {
      let parent = "";
      if (args[0]) parent = (await findEntry(args[0], { folders: true })).id;
      const items = (await listEntries())
        .filter((i) => i.parent === parent)
        .sort((a, b) => (a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
      if (!items.length) console.log("(empty)");
      for (const i of items) console.log(`${icon(i)} ${i.name}`);
      break;
    }

    case "tree": {
      const items = (await listEntries()).filter((i) => i.parent !== "trash");
      const print = (parent, indent) => {
        const children = items
          .filter((i) => i.parent === parent)
          .sort((a, b) => (a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
        for (const c of children) {
          console.log(`${indent}${icon(c)} ${c.name}`);
          if (c.type === "folder") print(c.id, indent + "  ");
        }
      };
      console.log("My files");
      print("", "  ");
      break;
    }

    case "upload": {
      if (!args[0]) fail("Usage: rmk upload <file.pdf|.epub> [folder]");
      const buffer = await readFile(args[0]);
      const entry = await upload(basename(args[0]), buffer);
      if (args[1]) {
        const folder = await findEntry(args[1], { folders: true });
        await moveEntry(entry.hash, folder.id);
      }
      console.log(`Uploaded ${basename(args[0])} — it will sync to your tablet shortly.`);
      break;
    }

    case "download": {
      if (!args[0]) fail("Usage: rmk download <name|id> [output-file]");
      const entry = await findEntry(args[0]);
      if (entry.type === "folder") fail(`"${entry.name}" is a folder.`);
      const { ext, data } = await download(entry.id, entry.hash);
      const out = args[1] ?? `${entry.name}.${ext}`;
      await writeFile(out, Buffer.from(data));
      console.log(`Saved ${out}`);
      break;
    }

    case "mkdir": {
      if (!args[0]) fail("Usage: rmk mkdir <name> [parent-folder]");
      const parent = args[1] ? (await findEntry(args[1], { folders: true })).id : "";
      await createFolder(args[0], parent);
      console.log(`Created folder "${args[0]}".`);
      break;
    }

    case "mv": {
      if (args.length < 2) fail("Usage: rmk mv <name|id> <folder|/>");
      const entry = await findEntry(args[0]);
      const dest = args[1] === "/" ? "" : (await findEntry(args[1], { folders: true })).id;
      await moveEntry(entry.hash, dest);
      console.log(`Moved "${entry.name}".`);
      break;
    }

    case "rename": {
      if (args.length < 2) fail("Usage: rmk rename <name|id> <new name>");
      const entry = await findEntry(args[0]);
      await renameEntry(entry.hash, args.slice(1).join(" "));
      console.log(`Renamed "${entry.name}" to "${args.slice(1).join(" ")}".`);
      break;
    }

    case "trash": {
      if (!args[0]) fail("Usage: rmk trash <name|id>");
      const entry = await findEntry(args[0]);
      await trashEntry(entry.hash);
      console.log(`Moved "${entry.name}" to trash.`);
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => fail(err.code === "NOT_PAIRED" ? err.message : `Error: ${err.message}`));
