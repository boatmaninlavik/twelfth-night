/**
 * 声音档案。
 *
 * 原来每做一首歌都要重录一遍、重签一遍。第二次下单的人会立刻发现这件事很蠢：
 * 「我上次不是已经唱过了吗」。而且它还有个更糟的后果 —— 每一单都在 bucket 里
 * 留一份新的录音，同一个人的声音散在 N 个地方，撤回时删不干净。
 *
 * 所以录音改成挂在**人**身上而不是挂在**单**上：一份档案，12 个月有效，
 * 期间下的单都用它。到期自动删，随时可以重录替换，随时可以删掉。
 *
 * 这不是一个纯粹的工程优化 —— 它把授权范围从「本订单」扩到了「本账号下的歌」，
 * 是实质变更。所以 consent.js 的版本号跟着升了一档，老用户会被要求重新同意。
 * 反过来说：**没升版本号就扩大授权范围，是这一整套里最不能犯的错。**
 *
 * ⚠️ deviceToken 这条退路要留意。
 * 服务端认 openid，但这个 app 拿不稳 openid（app.js 里 code2Session 失败是常态，
 * utils/library.js 正是为此才在本机自己记一份订单索引）。所以这里同样给一条
 * 设备令牌的退路，跟 library.js 是同一个思路。
 * 但**声音是敏感个人信息，令牌的安全性远不如 openid**：拿到令牌等于拿到那份
 * 录音的使用权。正式上线前应该收紧成"只认 openid"—— 等注册了正式小程序、
 * code2Session 稳定之后，把下面 token() 的调用点摘掉即可。
 */

const KEY = 'tn-voice-profile';
const TOKEN_KEY = 'tn-device-token';

/** 12 个月。跟授权书 3.1 写的必须是同一个数。 */
const MONTHS = 12;

function readStore(k) {
  try { return wx.getStorageSync(k) || null; }
  catch (e) { return null; }                 // 隐私模式下 storage 会抛，别让首屏崩掉
}

function writeStore(k, v) {
  try { wx.setStorageSync(k, v); } catch (e) { /* 存不下就这次有效 */ }
}

/**
 * 这台设备的令牌。第一次调用时生成并存下来。
 * Math.random 不是密码学安全的，但这里要的是"不重复"，不是"猜不到" ——
 * 真正的身份是 openid，令牌只是它拿不到时的退路。
 */
function token() {
  let t = readStore(TOKEN_KEY);
  if (!t) {
    t = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    writeStore(TOKEN_KEY, t);
  }
  return t;
}

/** 本机缓存的那份档案摘要。服务端才是准的，这份只用来避免首屏空一下。 */
function read() { return readStore(KEY); }

function save(p) {
  if (!p) return clear();
  writeStore(KEY, p);
}

function clear() {
  try { wx.removeStorageSync(KEY); } catch (e) { /* 清不掉也别崩 */ }
}

/** 还在有效期内吗。没有 expiresAt 的一律当过期 —— 宁可让人重录，不可超期使用。 */
function valid(p) {
  if (!p || !p.expiresAt) return false;
  const t = new Date(p.expiresAt).getTime();
  return !isNaN(t) && Date.now() < t;
}

/** 「2026 年 9 月 11 日录的」——档案卡上要让人一眼认出这是哪一次。 */
function when(p) {
  if (!p || !p.createdAt) return '';
  const d = new Date(p.createdAt);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 还剩多久。到期前一个月开始提示，免得人正要用的时候发现没了。 */
function daysLeft(p) {
  if (!valid(p)) return 0;
  return Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / 86400000);
}

module.exports = { MONTHS, token, read, save, clear, valid, when, daysLeft };
