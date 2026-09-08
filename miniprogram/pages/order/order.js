const api = require('../../utils/api.js');
const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');

/**
 * 定歌，第一步：唱给谁、什么场合、参考哪首歌。
 *
 * 原来这三样和「说说这个人/事」挤在同一页。那一页有两个问题：
 *   1. 太长 —— 一屏塞不下，人一进来看到的是一张表，不是一件事。
 *   2. 主次不分 —— 故事是这首歌的**内容**，另外三样只是它的边框，
 *      但它们长得一模一样（全是横线分栏），谁都不知道哪个重要。
 * 拆成两页之后各自只做一件事：这一页是「给谁、什么调子」，下一页才是「说什么」。
 *
 * 场合默认是「不指定」，而且那一颗排在最后。
 * 「可选」不靠"你可以不选"来表达，靠"默认就是不指定"来表达 ——
 * 取消是一个正向动作，用户不用猜"再点一下能不能取消"。
 */
Page({
  data: {
    occasions: ['婚礼', '告白', '给亲人', '倾诉', '生日', '道歉', '感恩'],
    occasion: '', theme: '', mode: '',
    results: [], searching: false, refSong: null,
  },

  onLoad() {
    nav.apply(this);
    // 从下一页退回来时把选过的填回去，别让人重选一遍。
    const d = app.globalData.draft || {};
    if (d.occasion || d.refSong) {
      this.setData({ occasion: d.occasion || '', theme: theme.slug(d.occasion || ''),
                     refSong: d.refSong || null });
    }
    this._toName = d.toName || '';
  },

  onShow() { mode.sync(this); },

  onToName(e) { this._toName = e.detail.value; },   // 打字过程中不 setData

  pick(e) {
    const v = e.currentTarget.dataset.v || '';
    this.setData({ occasion: v, theme: theme.slug(v) });
  },

  clearRef() { this.setData({ refSong: null, results: [] }); },

  pickRef(e) {
    // 整条歌直接挂在 data-song 上带过来。传 index 再回 results 里取的话，
    // 多一层间接就多一个取到 undefined 的机会 —— 而 refSong 一旦是 undefined，
    // wx:if 判否、列表又已清空，看起来就是"点了没反应"。
    const song = e.currentTarget.dataset.song;
    if (!song) return;
    this.setData({ refSong: song, results: [], searching: false });
  },

  // 每敲一个字就发一次请求会把搜索接口打爆，也会让结果乱序返回。
  // 停手 400ms 再搜，并且丢弃过期响应。
  onQuery(e) {
    const q = e.detail.value;
    clearTimeout(this._t);
    if (!q.trim()) return this.setData({ results: [], searching: false });
    // 必须显式给初值：this._seq 是 undefined 时 ++ 出来是 NaN，
    // 而 NaN !== NaN —— 下面那个"是不是最新一次请求"的判断会永远为假，
    // 结果是搜索成功了也不渲染，界面永远停在"搜索中…"。
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ searching: true });
    this._t = setTimeout(() => {
      api.searchSongs(q)
        .then((d) => { if (seq === this._seq) this.setData({ results: d.songs || [], searching: false }); })
        .catch(() => { if (seq === this._seq) this.setData({ results: [], searching: false }); });
    }, 400);
  },

  next() {
    // 连点两下会压两个页面进栈；小程序页面栈上限是 10，
    // 攒满之后 navigateTo 直接失败 —— 而失败是没有任何提示的。
    if (this._going) return;
    this._going = true;
    app.globalData.draft = {
      ...(app.globalData.draft || {}),
      occasion: this.data.occasion,
      toName: (this._toName || '').trim(),
      refSong: this.data.refSong,
    };
    wx.navigateTo({
      url: '/pages/story/story',
      // 必须有 fail：navigateTo 失败时什么都不会发生，界面上完全看不出来，
      // 表现就是"按钮点不动"。
      fail: (e) => {
        console.error('navigateTo story failed:', e);
        wx.showModal({ title: '打不开', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },

  back() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },
});
