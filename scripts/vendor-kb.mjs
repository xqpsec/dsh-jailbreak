import fs from 'node:fs';
const map = [
  ['C:/jalibreak/kb/primitivize.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-primitivize.js'],
  ['C:/jalibreak/kb/artifact.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-artifact.js'],
  ['C:/jalibreak/kb/augment.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-augment.js'],
  ['C:/jalibreak/kb/seedprim2.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-seedprim2.js'],
  ['C:/jalibreak/kb/seedprim.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-seedprim.js'],
  ['C:/jalibreak/kb/coreseed.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-coreseed.js'],
  ['C:/jalibreak/kb/seedhead.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-seedhead.js'],
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
