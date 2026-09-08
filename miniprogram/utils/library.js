/**
 * 这台设备做过的歌。
 *
 * 存在本地 storage，不是"缓存服务器数据"，而是**索引**：服务端认的是 openid，
 * 而 openid 现在拿不稳（测试号的 code2Session 会失败，日志里那条 40029 就是），
 * 拿不到就等于这台设备做过的歌全都找不回来了。订单 id 记在本地就没这个问题 ——
 * 换手机会丢，但内测阶段丢一台设备的历史，远比"每次都可能整个列表为空"轻。
 *
 * 每条只存够画出列表的那几样。歌是在服务器上做完的，本地不可能知道它什么时候好，
 * 所以状态每次进「我的」都重取一遍，本地那份只是上次看到的样子。
 *
 *   state  服务端状态：making | done | failed
 *   seen   用户**已经看过成品了**。这一条是本地权威的，服务端不知道也不该知道。
 *          扉页靠它决定要不要把人直接送回那首还没看过的歌。
 */
const KEY = 'tn-songs';
const MAX = 60;                        // 存不下无所谓，但别让 storage 无限长
const STALE = 7 * 24 * 3600 * 1000;    // 超过这个岁数就不再自动跳回去了

function list() {
  try {
    const a = wx.getStorageSync(KEY);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];                         // 隐私模式下 storage 会抛，当作没有历史
  }
}

function save(a) {
  try { wx.setStorageSync(KEY, a.slice(0, MAX)); } catch (e) { /* 存不下就这次生效 */ }
}

/** 下单成功时记一笔。新的在最前面。 */
function add(rec) {
  if (!rec || !rec.id) return;
  const a = list().filter((x) => x.id !== rec.id);
  a.unshift({ createdAt: Date.now(), state: 'making', seen: false, ...rec });
  save(a);
}

/** 服务端回来的数据回填（歌名是做出来才有的，下单那一刻还不知道）。 */
function patch(id, fields) {
  const a = list();
  const i = a.findIndex((x) => x.id === id);
  if (i < 0) return;
  a[i] = { ...a[i], ...fields };
  save(a);
}

function has() { return list().length > 0; }

/**
 * 还没被用户看过成品的那一单。
 *
 * 做一首要一天，没人会举着手机等 —— 关掉小程序是正常行为。他再打开的时候
 * 要找的就是那首歌，扉页据此直接把他送回去。
 *
 * 只认最近一单：同时挂两单是内测里不会发生的事，真发生了也该给他最新的那首。
 * 加一道岁数闸：万一有一单卡在中间永远做不完，没有这道闸的话这台设备的扉页
 * 就被它永久劫持了，怎么点都进不去。
 */
function pending() {
  const now = Date.now();
  return list().find((x) => !x.seen && x.state !== 'failed'
                            && now - (x.createdAt || 0) < STALE) || null;
}

module.exports = { list, add, patch, has, pending };
