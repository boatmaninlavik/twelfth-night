/**
 * 定调页：这首歌听起来是什么样。
 *
 * 位置在**故事和录音之间**。它属于"这首歌是什么"那一组
 * （给谁 → 场合 → 参考歌 → 故事 → 调子），录音和授权是提交前的最后一关，
 * 中间再插一个选择会把那一段叙事切断。
 *
 * 两种答法，回答的是同一个问题：
 *   · 挑一首歌 —— 目录（utils/songs.js，按场合分牌）或者搜
 *   · 挑一句话 —— 声音卡（utils/tunes.js）
 * 点中即出页，所以这一页没有按钮。
 *
 * 页面栈：扉页→定歌→故事→**调子**→录音→作品，六层。上限是 10，
 * 但 story.js 那条注释仍然成立 —— 以后再往里插页要先数一遍。
 */
const app = getApp();
const api = require('../../utils/api.js');
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');
const tunes = require('../../utils/tunes.js');

Page({
  data: {
    theme: '', mode: '',
    refSong: null,
    q: '', results: [], searching: false,
    tunes: tunes.TUNES,
  },

  onShow() { mode.sync(this); },

  onLoad() {
    nav.apply(this);              // 返回键和正文起点，对齐右上角胶囊
    const d = app.globalData.draft || {};
    this.setData({
      theme: theme.slug(d.occasion || ''),
      // 上一页选过的直接摆出来，别让人再找一遍。
      refSong: d.refSong || null,
    });
  },

  /* ── 答法一：一首歌 ──────────────────────────────── */

  /** 上一页已经选过的那首，就按它走。 */
  keepRef() { this.go({ key: 'ref', sound: '' }, this.data.refSong); },

  clearRef() { this.setData({ refSong: null }); },

  pickSong(e) {
    // 整条歌挂在 data-song 上带过来。传 index 再回数组里取的话，多一层间接
    // 就多一个取到 undefined 的机会 —— order.js 那条注释踩的是同一个坑。
    const song = e.currentTarget.dataset.song;
    if (!song) return;
    this.go({ key: 'ref', sound: '' }, song);
  },

  // 每敲一个字就发一次请求会把搜索接口打爆，也会让结果乱序返回。
  // 停手 400ms 再搜，并且丢弃过期响应。整段照 order.js 那一版，
  // 包括 this._seq 必须显式给初值：undefined 上 ++ 出来是 NaN，
  // 而 NaN !== NaN，"是不是最新一次请求"永远为假，搜到了也不渲染。
  onQuery(e) {
    const q = e.detail.value;
    this.setData({ q });
    clearTimeout(this._t);
    if (!q.trim()) return this.setData({ results: [], searching: false });
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ searching: true });
    this._t = setTimeout(() => {
      api.searchSongs(q)
        .then((d) => { if (seq === this._seq) this.setData({ results: d.songs || [], searching: false }); })
        .catch(() => { if (seq === this._seq) this.setData({ results: [], searching: false }); });
    }, 400);
  },

  /* ── 答法二：一句话 ──────────────────────────────── */

  pickTune(e) {
    const k = e.currentTarget.dataset.k || '';
    // 挑了声音卡就把参考歌清掉：两种答法是**互斥**的，
    // 两个都送过去等于给模型两套互相打架的指令。
    this.go({ key: k, sound: tunes.sound(k) }, null);
  },

  /** 不指定。跟定歌页的「不指定」是同一个立场：留白是允许的，不是遗漏。 */
  free() { this.go({ key: 'free', sound: '' }, null); },

  /* ── 出页 ────────────────────────────────────────── */

  /**
   * 记下选择然后进录音页。
   * sound 是给写歌模型的英文约束，用户从头到尾看不见它 ——
   * 看得见的只有那句人话，或者那首歌的名字。
   */
  go(tune, refSong) {
    // 连点两下会压两个 record 页进栈；栈满之后 navigateTo 直接失败，
    // 而失败是没有任何提示的（story.js 那条注释踩的是同一个坑）。
    if (this._going) return;
    this._going = true;

    app.globalData.draft = {
      ...(app.globalData.draft || {}),
      tune,
      // 参考歌回写进 draft：定调页选的那首要能盖掉定歌页选的那首，
      // 选了声音卡则清空 —— record.js 从 draft 里取，取到什么就发什么。
      refSong: refSong || null,
    };

    wx.navigateTo({
      url: '/pages/record/record',
      // 必须有 fail：失败时界面上什么都看不出来，表现就是"按钮点不动"。
      fail: (e) => {
        this._going = false;
        console.error('navigateTo record failed:', e);
        wx.showModal({ title: '打不开录音页', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },

  back() { wx.navigateBack(); },
});
