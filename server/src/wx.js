/**
 * 微信开放接口：拿 openid、发订阅消息。
 *
 * 订阅消息是小程序**唯一**能主动推给用户的通道，而且**不需要用户关注任何公众号**——
 * 用户在小程序里点一次授权就行。这正是我们要的。
 *
 * 三个前提，缺一条就发不出去：
 *   1. openid  —— wx.login 拿 code，这里换成 openid，下单时存进订单
 *   2. 用户授权 —— 小程序端 wx.requestSubscribeMessage，必须在点击回调里调
 *   3. 模板 ID  —— 在公众平台「订阅消息」里从模板库选一个，填进 WX_TMPL_SONG_READY
 *
 * 第 3 条现在拿不到：测试号没有服务类目，getcategory 返回空数组，
 * 因而无法从模板库添加模板。等注册了正式小程序、选了类目就能拿到。
 * 所以这里的发送在没配模板 ID 时只打日志、不报错 —— 不挡交付。
 *
 * 一次授权只能发一条（一次性订阅）。所以授权要放在"用户刚下完单、正期待结果"
 * 的那一刻问，不要在首屏问。
 */
const API = 'https://api.weixin.qq.com';

let cachedToken = null;                 // { value, exp }

function conf() {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APP_SECRET;
  if (!appid || !secret) throw new Error('WX_APPID / WX_APP_SECRET 没配');
  return { appid, secret };
}

/** access_token 有效期 7200 秒，且微信对获取频率有限制，必须缓存。 */
async function token() {
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.value;
  const { appid, secret } = conf();
  const r = await fetch(
    `${API}/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  ).then((x) => x.json());
  if (!r.access_token) throw new Error(`拿 token 失败: ${JSON.stringify(r)}`);
  // 提前 5 分钟过期，避免边界上用到一个刚失效的 token
  cachedToken = { value: r.access_token, exp: Date.now() + (r.expires_in - 300) * 1000 };
  return cachedToken.value;
}

/** 小程序 wx.login 的 code → openid。 */
export async function openidFromCode(code) {
  const { appid, secret } = conf();
  const r = await fetch(
    `${API}/sns/jscode2session?appid=${appid}&secret=${secret}`
    + `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  ).then((x) => x.json());
  if (!r.openid) throw new Error(`code2Session 失败: ${r.errcode} ${r.errmsg}`);
  return r.openid;
}

/**
 * 「你的歌做好了」。
 *
 * 模板 ID 没配就跳过 —— 交付本身不该被通知能力挡住。
 * 发送失败也只记日志：用户下次打开小程序照样能看到歌。
 */
export async function notifySongReady(openid, { title, toName }) {
  const tmpl = process.env.WX_TMPL_SONG_READY;
  if (!openid) return { skipped: 'no-openid' };
  if (!tmpl) return { skipped: 'no-template' };

  const body = {
    touser: openid,
    template_id: tmpl,
    page: 'pages/index/index',
    // 字段名（thing1 / thing2 …）由模板决定，换模板要照着后台的字段改。
    data: {
      thing1: { value: String(title || '你的歌').slice(0, 20) },
      thing2: { value: String(toName || '').slice(0, 20) || '已完成' },
    },
    miniprogram_state: process.env.WX_MP_STATE || 'developer',
  };
  const r = await fetch(`${API}/cgi-bin/message/subscribe/send?access_token=${await token()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((x) => x.json());
  if (r.errcode) throw new Error(`订阅消息发送失败: ${r.errcode} ${r.errmsg}`);
  return { sent: true };
}
