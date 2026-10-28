import fs from 'node:fs';
const map = [
  ['C:/jalibreak/kb/primitivize.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-primitivize.js'],
  ['C:/jalibreak/kb/artifact.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-artifact.js'],
  ['C:/jalibreak/kb/augment.mjs', 'C:/jalibreak/release/dsh-jalibreak/lib/kb-augment.js'],
];
for (const [src, dst] of map) {
  const text = fs.readFileSync(src, 'utf8').replaceAll("from './primitivize.mjs'", "from './kb-primitivize.js'");
  fs.writeFileSync(dst, text, 'utf8');
  const back = fs.readFileSync(dst, 'utf8');
  console.log(`${dst} ${back.length} chars ok=${back === text}`);
}
