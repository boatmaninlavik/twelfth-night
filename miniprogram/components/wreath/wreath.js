/**
 * 花环。
 *
 * 参照瑞典仲夏节头上戴的那种：一圈编起来的绿叶，几簇花零星缀在上面 ——
 * 不是一圈等距钉着的花。所以叶子绕满整环、一片朝外一片朝内交错（编织感就在这），
 * 花只有五朵，角度是不匀的。匀了就变成图案，不是编出来的东西了。
 *
 * 全册唯一放颜色的地方，所以平涂、无描边、无渐变、无阴影，形状简到不能再简，
 * 颜色一步不让 —— 马蒂斯剪纸那条线，不是插画。
 *
 * 颜色一律写成 var(--leaf-x) / var(--bloom-x) 放在行内 style：
 * 自定义属性沿 DOM 继承，组件的样式隔离拦不住它，所以换到夜间这一环自己就跟着变，
 * 组件里一行判断都不用写。
 */
const R = 104;                          // 环半径

const LEAF_N = 18;
const LEAF_W = [30, 24, 27];            // 三档大小循环 —— 环上不匀才像编的
const LEAF_C = ['a', 'b', 'c', 'b'];

const LEAVES = [];
for (let i = 0; i < LEAF_N; i++) {
  const a = (360 / LEAF_N) * i;
  const w = LEAF_W[i % LEAF_W.length];
  const out = i % 2 ? 6 : -5;           // 一片压外一片压内，这就是编织的错落
  const tilt = 118 + (i % 2 ? 24 : -24);// 叶尖顺着环走，不是全部朝外扎
  LEAVES.push({
    k: i,
    style: `width:${w}rpx;height:${Math.round(w * 0.5)}rpx;`
         + `background: var(--leaf-${LEAF_C[i % LEAF_C.length]});`
         + `transform: translate(-50%,-50%) rotate(${a}deg)`
         + ` translateY(-${R + out}rpx) rotate(${tilt}deg);`,
  });
}

// 花的角度是手摆的，故意不等分
const BLOOM_AT = [
  { a:  -6, r: 25, p: 'a', c: 'b' },
  { a:  64, r: 18, p: 'b', c: 'a' },
  { a: 138, r: 21, p: 'a', c: 'b' },
  { a: 210, r: 17, p: 'b', c: 'a' },
  { a: 291, r: 20, p: 'b', c: 'a' },
];

const BLOOMS = BLOOM_AT.map((b, i) => {
  const pw = Math.round(b.r * 0.80);
  const d  = Math.round(b.r * 0.40);
  const petals = [];
  for (let n = 0; n < 5; n++) {
    // 先转到自己那一瓣的方位，推出去，再转 45° 把瓣尖朝外
    petals.push(
      `width:${pw}rpx;height:${pw}rpx;`
      + `background: var(--bloom-${b.p});`
      + `transform: translate(-50%,-50%) rotate(${n * 72}deg) translateY(-${d}rpx) rotate(45deg);`
    );
  }
  return {
    k: i,
    // 花压在绿叶上面，所以比叶子再往外挪一点
    style: `transform: rotate(${b.a}deg) translateY(-${R + 5}rpx);`,
    petals,
    core: `width:${Math.round(b.r * 0.34)}rpx;height:${Math.round(b.r * 0.34)}rpx;`
        + `background: var(--bloom-${b.c});`,
  };
});

Component({
  properties: {
    scale: { type: String, value: '1' },
  },
  data: { leaves: LEAVES, blooms: BLOOMS },
});
