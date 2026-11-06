/**
 * 声音授权。一份文件，一次勾选，一个按钮。
 *
 * 原来是两层：录音前一张「单独同意」，下单时再签一份「授权书」。合并成一份之后，
 * **时机必须定在按下录音键之前** —— 《个人信息保护法》要求处理敏感个人信息
 * 在采集前取得单独同意，这一层不能往后挪到下单。
 * 「按单留证」没有丢：下单时把这份已签的存证随订单一起送上去（record.js），
 * 用户不必再点第二次。
 *
 * 法律基础：
 *   ·《民法典》1023 条 —— 自然人的声音参照肖像权保护
 *   ·《个人信息保护法》28–30 条 —— 声纹属敏感个人信息，须**单独同意**、单独告知
 *   ·《个人信息保护法》15、47 条 —— 可随时撤回；撤回或目的实现后应主动删除
 *
 * 合并之后仍然要守住的三条，少一条这份同意就可能不成立：
 *   · 它是一个**独立**的弹窗，不与用户协议或任何其他条款合并
 *   · 勾选框**默认不勾**，不写「我已阅读并同意全部协议」这类打包表述
 *   · 拒绝**不挡下单** —— 换歌手音色照样能把歌做完
 *
 * ⚠️ 文案与代码必须对得上。这里每一句承诺都对应 server 里真实存在的行为。
 * 承诺一件产品做不到的事，比不承诺糟糕得多。以后改了产品行为，
 * 必须回来改这段文字**并升版本号让老用户重新同意**。
 */

/* 版本号。条款一改就往上加 —— 存证里记的是版本号，出事时要能还原用户当时
   看到的究竟是哪一版。版本一升，已同意过的老用户会被要求重新同意（见 needs）。

   2026-11-06.1：两层合并为一份，精简到一页；去掉年龄分档与监护人代授权；
   去掉约定管辖条款。这是**实质变更**，所以升号。
   2026-11-06.2：录音保存期 12 个月改为 3 个月。缩短保存期对用户是更有利的
   变更，但照样要升号 —— 版本号的作用是**还原「他当时看到的是哪一版」**，
   文本变了而号不变，旧存证指向的就是一份已经不存在的条款。 */
const VERSION = '2026-11-06.2';
const KEY = 'tn-voice-consent';     // 本机「已同意」缓存
const GRANTS_KEY = 'tn-voice-grants';  // 本机留存的逐单签署记录

/** 运营主体。授权书上没有被授权方全称是签不成的。 */
const PARTY = '上海声之镜像科技有限公司';


const DOC = {
  version: VERSION,
  eyebrow: '授 权',
  title: '关于你的声音',
  lede: `被授权方：${PARTY}\n下面这件事，需要你单独同意一次。`,

  sections: [
    {
      h: '做什么用',
      p: '只用来把你下单的歌，主唱换成你的声音。除此之外不作任何用途。',
    },
    {
      h: '不做什么',
      p: '不训练面向公众的模型；不提供、不出售给任何第三方；不用作我们的广告、宣传或案例展示。',
    },
    {
      h: '存多久',
      p: '录音保存 3 个月，期间再做一首不必重录。到期我们主动删除，不用你申请；你也可以随时提前删掉或重录替换。\n'
       + '只保存你唱的那段音频，不生成任何可跨账号复用的声线模型。',
    },
    {
      h: '随时可以反悔',
      p: '在录音页底下的「授权书」里点「撤回授权并删除录音」，我们会删掉这段录音和它的全部副本。\n'
       + '撤回不影响此前已经完成的交付 —— 做好的歌还是你的。',
    },
    {
      h: '你的声明',
      p: '这段录音是你本人现场唱的，不是别人的声音，也不是任何已有的录音、影视或音乐素材。\n'
       + '（这套流程只接受现场录制，不接受上传音频文件。）'
    },
    {
      h: '歌是你的',
      p: '歌词和旋律依据你提供的素材原创，著作权归你；我们不保留任何使用权，也不会对外发布。\n'
       + '制作过程使用了人工智能辅助技术，我们已依法在交付物中标识。',
    },
    {
      h: '如果你不同意',
      p: '你仍然可以下单。我们会用歌手的音色把这首歌做完 —— 词、曲、编曲都不变，只是唱的人不是你。',
    },
  ],

  // **只有一条**，而且默认不勾。不写「同意全部协议」这类打包表述。
  checks: ['我已阅读并同意上述内容，同意你们处理我的声音信息'],
  agree: '同意',
  decline: '先不了，用歌手音色',
};


/* ── 存证 ─────────────────────────────────────────────
   授权书本身不重要，**能证明「这个人在这个时间确实同意了」才重要**。
   下面这些字段就是出事时会被拿出来看的东西。

   「滚动到底」最容易被忽略，但它是证明用户有机会读完全文的直接证据，
   技术上不过是接一个 bindscrolltolower，成本几乎为零。 */

/**
 * 装配一份存证。
 * @param {object} o
 *   version   条款版本号
 *   checks    勾选动作的结果，长度与 DOC.checks 一致
 *   shownAt   弹窗打开的时间戳（用来算展示时长 —— 秒开秒关的同意是站不住的）
 *   readEnd   是否滚动到过底部
 *   extra     额外字段（录音方式、提示语、音频哈希等）
 */
function evidence(o) {
  const now = Date.now();
  let dev = {};
  try {
    // getDeviceInfo / getAppBaseInfo 是新接口，老基础库上没有，退回 getSystemInfoSync。
    const d = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    const a = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    dev = {
      brand: d.brand, model: d.model, system: d.system,
      platform: d.platform || a.platform,
      sdk: a.SDKVersion, appVersion: a.version,
    };
  } catch (e) { /* 取不到设备信息不该挡住签署 */ }

  return {
    version: o.version || VERSION,
    party: PARTY,
    signedAt: new Date(now).toISOString(),
    dwellMs: o.shownAt ? now - o.shownAt : null,   // 展示时长
    readToEnd: !!o.readEnd,                        // 滚动到底
    checks: (o.checks || []).slice(),              // 勾选动作
    device: dev,
    ...(o.extra || {}),
  };
}


/* ── 本地状态 ─────────────────────────────────────────
   注意：这只是「这台设备上这个人同意过」的缓存，**不是**存证本身。
   真正的存证随订单送到服务端（record.js 下单时带上），
   本地这份只用来决定下次进录音页要不要再问一遍。 */

function read() {
  try { return wx.getStorageSync(KEY) || null; }
  catch (e) { return null; }
}

/** 没签过，或者签的是旧版本条款 —— 都要重新问一次。 */
function needs() {
  const r = read();
  return !r || r.version !== VERSION;
}

function save(ev) {
  try { wx.setStorageSync(KEY, ev); }
  catch (e) { /* 存不下不该挡住录音 */ }
}

function clear() {
  try { wx.removeStorageSync(KEY); }
  catch (e) { /* 删不掉也要继续往下走撤回流程 */ }
}

/** 逐单的签署记录，本机留一份备查（服务端那一份才是正本）。 */
function saveGrant(ev) {
  try {
    const all = listGrants();
    all.push(ev);
    wx.setStorageSync(GRANTS_KEY, all.slice(-50));
  } catch (e) { /* 存不下不该挡住下单 */ }
}

function listGrants() {
  try { return wx.getStorageSync(GRANTS_KEY) || []; }
  catch (e) { return []; }
}

module.exports = {
  DOC, VERSION, PARTY,
  evidence, read, needs, save, clear, saveGrant, listGrants,
};
