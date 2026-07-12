# reMarkable App

A small local web app + CLI that talks to your reMarkable tablet through the
reMarkable cloud. Browse your files, drag-and-drop PDFs/EPUBs onto the tablet,
download documents and notebooks, and organize folders — all from your
computer, no cables needed.

Built on [rmapi-js](https://github.com/erikbrinkman/rmapi-js), the maintained
JavaScript implementation of the reMarkable sync API.

> **Note:** the reMarkable cloud API is unofficial (reverse-engineered), and
> your tablet must have cloud sync enabled (a reMarkable account connected).

## Requirements

- Node.js 18 or newer
- A reMarkable tablet connected to a reMarkable account

## Setup

```sh
cd remarkable-app
npm install
```

## Pairing (one time)

The app authenticates like any other reMarkable desktop app:

1. Visit <https://my.remarkable.com/device/desktop/connect> and sign in with
   the account your tablet uses.
2. You'll get an 8-letter one-time code.
3. Enter it in the web UI (or run `node src/cli.js pair <code>`).

The resulting device token is stored in `~/.remarkable-app/device-token`
(file mode 600). Delete it — or click **Unpair** — to disconnect. You can
also revoke the pairing from your reMarkable account settings at any time.

## Web app

```sh
npm start
# → http://127.0.0.1:3141
```

- **Browse** your tablet's folders with breadcrumb navigation
- **Upload** by dragging PDF/EPUB files onto the drop zone (they sync to the
  tablet within moments)
- **Download** any document — PDFs and EPUBs come back in their native format;
  handwritten notebooks download as a `.rmdoc` archive
- **Organize**: create folders, rename, move to trash

The server binds to `127.0.0.1` only. Set `PORT`/`HOST` env vars to change.

## CLI

```sh
node src/cli.js pair <one-time-code>
node src/cli.js ls                     # list root
node src/cli.js ls "Books"             # list a folder
node src/cli.js tree                   # whole folder tree
node src/cli.js upload paper.pdf       # send to tablet
node src/cli.js upload book.epub Books # send into a folder
node src/cli.js download "paper"       # fetch back (PDF/EPUB/notebook)
node src/cli.js mkdir "Papers"
node src/cli.js mv "paper" Papers
node src/cli.js rename "paper" "Great paper"
node src/cli.js trash "old notes"
```

(Or `npm link` once to get a global `rmk` command.)

## How it works

- `src/rm.js` — pairing, token persistence, and a thin wrapper over rmapi-js
- `src/server.js` — dependency-free `node:http` server exposing a small JSON
  API (`/api/items`, `/api/upload`, `/api/download`, …)
- `src/public/index.html` — the whole UI in one self-contained file
- `src/cli.js` — terminal interface over the same wrapper

"Trash" is implemented the same way the tablet does it: entries are moved to
the special `trash` folder rather than hard-deleted.
