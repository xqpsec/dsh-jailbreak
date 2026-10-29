import fs from 'node:fs';
const map = [
  ['C:/jailbreak/kb/primitivize.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-primitivize.js'],
  ['C:/jailbreak/kb/artifact.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-artifact.js'],
  ['C:/jailbreak/kb/augment.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-augment.js'],
  ['C:/jailbreak/kb/seedprim2.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-seedprim2.js'],
  ['C:/jailbreak/kb/seedprim.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-seedprim.js'],
  ['C:/jailbreak/kb/coreseed.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-coreseed.js'],
  ['C:/jailbreak/kb/seedhead.mjs', 'C:/jailbreak/release/dsh-jailbreak/lib/kb-seedhead.js'],
];
for (const [src, dst] of map) {
  const text = fs.readFileSync(src, 'utf8')
    .replaceAll("from './primitivize.mjs'", "from './kb-primitivize.js'")
    .replaceAll("from './artifact.mjs'", "from './kb-artifact.js'")
    .replaceAll("from './seedprim2.mjs'", "from './kb-seedprim2.js'")
    .replaceAll("from './seedprim.mjs'", "from './kb-seedprim.js'")
    .replaceAll("from '../kb/seedprim.mjs'", "from './kb-seedprim.js'");
  fs.writeFileSync(dst, text, 'utf8');
  const back = fs.readFileSync(dst, 'utf8');
  console.log(`${dst} ${back.length} chars ok=${back === text}`);
}
