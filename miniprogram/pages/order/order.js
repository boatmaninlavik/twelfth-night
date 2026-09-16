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
/** 默认露出来的四个。 */
const COMMON = ['给亲人', '生日', '告白', '婚礼'];

/**
 * 全部十二个。次序：先关系，再时机，最后是**没有收信人**的那三个。
 *
 * 最后那一组是另一回事：想念、一段日子、倾诉都不是"送给谁"，
 * 而是写给自己的。放在一起收尾，人扫到那儿就知道换类别了。
 */
const ALL = [
  '婚礼', '告白', '给亲人', '给孩子',              // 关系：送给某个人
  '生日', '纪念日', '感恩', '道歉', '鼓舞',        // 时机：为某件事
  '送别', '分手', '想念',                          // 离别与失去
  '一段日子', '倾诉',                              // 写给自己
];

Page({
  data: {
    /* 十个情景一次全铺出来是**选择过载**，而且这一栏本来就是可选的 ——
       用一个十一格的大网格去呈现一件可以不答的事，等于把它办成了必答题。

       所以默认只露四个最常用的，其余收进「更多」。
       露哪四个是按送歌的实际频次拍的：生日最高，其次是给亲人（父母、爱人），
       告白和婚礼频次低一些但情绪最重、也最愿意为它花钱。
       这四个大概能盖住多数人；盖不住的那些点一下「更多」就全在。

       排序仍然是先关系、后时机，同类挨着才扫得快 ——
       人扫这一排是在找"哪个像我"，别按字数或者拼音排。 */
    occasions: [],           // 实际显示的，由 onLoad / toggleMore 填
    moreOpen: false,
    occasion: '', theme: '', mode: '',
    results: [], searching: false, refSong: null,
  },

  onLoad() {
    nav.apply(this);
    // 从下一页退回来时把选过的填回去，别让人重选一遍。
    const d = app.globalData.draft || {};
    const oc = d.occasion || '';
    if (oc || d.refSong) {
      this.setData({ occasion: oc, theme: theme.slug(oc), refSong: d.refSong || null });
    }
    this._toName = d.toName || '';

    // 退回来时选中的那个如果藏在「更多」里，就直接展开 ——
    // 不展开的话他会看见自己选过的东西凭空消失，以为选丢了。
    this.setData({
      moreOpen: !!oc && COMMON.indexOf(oc) < 0,
      occasions: (!!oc && COMMON.indexOf(oc) < 0) ? ALL : COMMON,
    });
  },

  onShow() { mode.sync(this); },

  toggleMore() {
    const open = !this.data.moreOpen;
    this.setData({ moreOpen: open, occasions: open ? ALL : COMMON });
  },

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
    /* ⚠️ 对比期间：正常流程走 2b 圆签（pages/storyb）。
       2c 一条线（pages/story）没删，从开发者工具的编译模式还能进。

       为什么要改这一行：场合是在定歌页选的，只有从这儿跳过去，
       故事页才拿得到它、六个圆签才会显示本场合的叫法。
       之前靠编译模式直接启动 storyb，跳过了定歌页，场合永远是空的，
       看到的就永远是通用那六个。

       比完之后把这一行改回 '/pages/story/story' 就切回 2c。 */
    wx.navigateTo({
      url: '/pages/storyb/storyb',
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
