/* 验牌：把 utils/cues.js 里所有牌按四条规矩扫一遍。
   改完文案跑一下，比肉眼可靠。

   用法：node server/assets/提词卡-验牌.cjs
   （放在 server/ 下所以用 .cjs —— server/package.json 是 "type": "module"） */
const path = require('path');
const cues = require(path.join(__dirname, '../../miniprogram/utils/cues.js'));

const OCS = ['婚礼', '告白', '给亲人', '给孩子', '生日', '感恩', '道歉', '送别', '想念', '倾诉', ''];
const TYPES = ['open', 'then', 'say', 'thing', 'place', 'who'];

/* 四条规矩，越靠前越硬。
   命中不等于一定错 —— 有几条是"值得再看一眼"，不是"必须改"。 */
const RULES = [
  { k: '是非题',   re: /吗[？?]?$/,
    why: '答"是/否"就完了，逼不出内容' },
  { k: '排名题',   re: /最[难大得好多重要舍]/,
    why: '「最」一出现，人给的是排名不是画面' },
  { k: '反事实',   re: /^如果(没有|不是)|应该怎么做$/,
    why: '答出来是检讨或猜测，写不出画面' },
  { k: '缺宾语',   re: /做过一件[，,]/,
    why: '「一件」后面缺「事」' },
];

let cards = 0;
const hits = [];
const thin = [];

for (const oc of OCS) {
  const deck = cues.deck(oc);
  cards += deck.length;

  // 每一类至少要有一张，否则那个圆签只能退回通用题
  const by = {};
  for (const t of TYPES) by[t] = deck.filter((c) => c.t === t).length;
  const miss = TYPES.filter((t) => !by[t]);
  if (miss.length) thin.push(`${(oc || '通用').padEnd(4)} 缺 ${miss.join(' ')}`);

  for (const c of deck) {
    if (!c.t) hits.push(`${oc || '通用'} · 没打类型标 · ${c.q}`);
    if (!TYPES.includes(c.t)) hits.push(`${oc || '通用'} · 类型标不认识(${c.t}) · ${c.q}`);
    for (const r of RULES) {
      if (r.re.test(c.q)) hits.push(`${oc || '通用'} · ${r.k} · ${c.q}\n      ${r.why}`);
    }
  }
}

console.log(`共 ${cards} 张牌`);
console.log('');
console.log(hits.length ? `可疑 ${hits.length} 处：\n  ${hits.join('\n  ')}` : '四条规矩：没有命中');
console.log('');
console.log(thin.length
  ? `这些场合的某些圆签会退回通用题池（不是错，只是少了本场合的语气）：\n  ${thin.join('\n  ')}`
  : '十一副牌六类齐全');
