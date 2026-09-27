// Downloads pixiv's VRM 1.0 sample model as a starter avatar for the default persona.
// It's free to use and redistribute (VRM Public License 1.0); swap in your own any time.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE =
  'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
const target = fileURLToPath(new URL('../models/mia.vrm', import.meta.url));

if (await fs.stat(target).catch(() => null)) {
  console.log(`${target} already exists; delete it first to download the sample again.`);
  process.exit(0);
}
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Download failed (${res.status})`);
await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
console.log(`Saved ${target}\nModel: "VRM1_Constraint_Twist_Sample" by pixiv Inc., VRM Public License 1.0`);
