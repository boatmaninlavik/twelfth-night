/* 查：界面上会出现的汉字，有哪些不在子集字体里。
   不在的那些会掉回系统字体 —— 字形、字重、字宽都不同，看着就是"不对齐"。 */
const fs = require('fs');
const path = require('path');

const MP = 'C:/code/twelfth-night-main/twelfth-night-main/miniprogram';
const FONT = 'C:/code/twelfth-night-main/twelfth-night-main/server/assets/tn-serif-400.ttf';

function coverage(p) {
  const b = fs.readFileSync(p);
  const nT = b.readUInt16BE(4);
  let co = 0;
  for (let i = 0; i < nT; i++) {
    const q = 12 + i * 16;
    if (b.toString('ascii', q, q + 4) === 'cmap') co = b.readUInt32BE(q + 8);
  }
  const n = b.readUInt16BE(co + 2);
  let best = 0, bs = -1;
  for (let i = 0; i < n; i++) {
    const q = co + 4 + i * 8;
    const pl = b.readUInt16BE(q), en = b.readUInt16BE(q + 2), of = b.readUInt32BE(q + 4);
    const s = (pl === 3 && en === 10) ? 3 : (pl === 3 && en === 1) ? 2 : (pl === 0) ? 1 : 0;
    if (s > bs) { bs = s; best = co + of; }
  }
  const set = new Set();
  const segX2 = b.readUInt16BE(best + 6), seg = segX2 / 2;
  const eO = best + 14, sO = eO + segX2 + 2, dO = sO + segX2, rO = dO + segX2;
  for (let s = 0; s < seg; s++) {
    const e = b.readUInt16BE(eO + s * 2), st = b.readUInt16BE(sO + s * 2);
    const d = b.readInt16BE(dO + s * 2), ro = b.readUInt16BE(rO + s * 2);
    if (st === 0xFFFF) continue;
    for (let c = st; c <= e && c !== 0x10000; c++) {
      let g;
      if (ro === 0) g = (c + d) & 0xFFFF;
      else {
        const gi = rO + s * 2 + ro + (c - st) * 2;
        if (gi + 1 >= b.length) continue;
        g = b.readUInt16BE(gi);
        if (g) g = (g + d) & 0xFFFF;
      }
      if (g) set.add(c);
    }
  }
  return set;
}

const font = coverage(FONT);

const used = new Map();
const isHan = (ch) => /[\u4e00-\u9fff]/.test(ch);
function add(s, where) {
  for (const ch of String(s)) if (isHan(ch) && !used.has(ch)) used.set(ch, where);
}

// JS：先去掉注释（注释不会显示），再取字符串字面量
function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
          .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}
const jsFiles = [
  'utils/cues.js', 'utils/tunes.js', 'utils/consent.js', 'utils/voice.js', 'utils/library.js',
  'pages/song/song.js', 'pages/order/order.js', 'pages/record/record.js',
  'pages/story/story.js', 'pages/tune/tune.js', 'pages/mine/mine.js', 'pages/index/index.js',
];
for (const f of jsFiles) {
  const t = stripComments(fs.readFileSync(path.join(MP, f), 'utf8'));
  for (const m of t.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
    add(m[1] || m[2] || m[3] || '', f);
  }
}

// WXML：去掉注释，取标签之间的文字和 placeholder
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.wxml')) continue;
    const t = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of t.matchAll(/>([^<>]+)</g)) add(m[1], e.name);
    for (const m of t.matchAll(/placeholder="([^"]*)"/g)) add(m[1], e.name);
  }
}
walk(path.join(MP, 'pages'));

const missing = [...used.entries()].filter(([c]) => !font.has(c.codePointAt(0)));

console.log('字体子集收录汉字：  ' + [...font].filter((c) => c >= 0x4e00 && c <= 0x9fff).length);
console.log('界面上会出现的汉字：' + used.size);
console.log('字体里没有的：      ' + missing.length + '  ← 这些会掉回系统字体');
console.log('');

if (missing.length) {
  const by = {};
  for (const [c, w] of missing) (by[w] ||= []).push(c);
  for (const w of Object.keys(by).sort()) {
    console.log('  ' + w.padEnd(20) + by[w].join(''));
  }
  console.log('');
  console.log('── 缺字全集（重新做子集时要补进去）──');
  console.log(missing.map(([c]) => c).join(''));
  console.log('');
  console.log('── 界面全部用字（建议直接拿这一串重做子集）──');
  console.log([...used.keys()].sort().join(''));
}
