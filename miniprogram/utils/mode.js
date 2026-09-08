/**
 * 明暗。
 *
 * 纸是默认，夜是用户自己在扉页点开的，选择记在本地 storage 里。
 * 换肤本身只是往页面根 view 上加一个 .night 类 —— 整套配色都是 CSS 变量，
 * 翻十个变量就够了，没有任何一条布局规则需要判断当前是白天还是黑夜。
 *
 * 但有两样东西不归 WXSS 管，只能运行时设：右上角胶囊按钮的颜色，
 * 和下拉回弹时露出来的窗口底色。忘了这两个，深色模式下会各露一道白边。
 */
const KEY = 'tn-mode';
const PAPER = '#F7F4ED';
const NIGHT = '#131219';

function read() {
  try { return wx.getStorageSync(KEY) === 'night' ? 'night' : 'day'; }
  catch (e) { return 'day'; }             // 隐私模式下 storage 会抛，别让首屏崩掉
}

function write(m) {
  try { wx.setStorageSync(KEY, m); } catch (e) { /* 存不下就这次生效 */ }
}

let painted = null;                       // 上一次真正设过的色，没变就不再穿桥

function paint(m) {
  if (m === painted) return;              // setNavigationBarColor / setBackgroundColor
  painted = m;                            // 都是跨线程调用，每次进页面白调两次不划算
  const night = m === 'night';
  const bg = night ? NIGHT : PAPER;
  wx.setNavigationBarColor({
    frontColor: night ? '#ffffff' : '#000000',
    backgroundColor: bg,
  });
  wx.setBackgroundColor({
    backgroundColor: bg, backgroundColorTop: bg, backgroundColorBottom: bg,
  });
}

/** 每个页面 onShow 调一次：从别的页面切回来时用户可能已经改过了。 */
function sync(page) {
  const m = read();
  paint(m);
  page.setData({ mode: m === 'night' ? 'night' : '' });
  return m;
}

function toggle(page) {
  const m = read() === 'night' ? 'day' : 'night';
  write(m);
  paint(m);
  page.setData({ mode: m === 'night' ? 'night' : '' });
  return m;
}

module.exports = { read, sync, toggle };
