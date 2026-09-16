const mode = require('../../utils/mode.js');
const library = require('../../utils/library.js');
const F = require('../../utils/feste.js');

// 十二道芒：四长八短，加起来十二 —— 题名就在这颗星里。
// 六根条各转 30 度，每根两头各出一道芒，六根 = 十二道。
const RAYS = [
  { deg: 0,   long: true  },
  { deg: 90,  long: true  },
  { deg: 30,  long: false },
  { deg: 60,  long: false },
  { deg: 120, long: false },
  { deg: 150, long: false },
];

Page({
  data: { rays: RAYS, mode: '', returning: false, crown: F.CROWN, face: F.FACE },

  /**
   * 等着的那首歌，直接送回去。
   *
   * 做一首要一天，没人会举着手机等 —— 关掉小程序是正常行为，不是放弃。
   * 他再打开的时候要找的就是那首歌，让他从扉页自己点进去是把这一下办砸了。
   *
   * 放 onLoad 不放 onShow：onShow 每次从作品页返回都会再触发一次，
   * 那样他就被锁在那一页里出不来了。
   *
   * 但光靠 onLoad 不够 —— 原来那句注释里"扉页整个会话只 load 一次"是**错的**：
   * 作品页的返回会 reLaunch 回扉页，那会重建页面实例、onLoad 再跑一遍，
   * 于是人又被送回作品页。两页互相弹，扉页永远够不着。
   * 所以另记一个会话级的标记：**送过一回就不再送**。
   * 用户主动退出来，就是明确表示他现在不想看那一页 —— 得认这个意思。
   */
  onLoad() {
    const app = getApp();
    if (app.globalData.resumed) return;

    const p = library.pending();
    if (!p) return;

    app.globalData.resumed = true;
    wx.navigateTo({
      url: `/pages/song/song?id=${p.id}&occasion=${encodeURIComponent(p.occasion || '')}`,
      // 失败什么都不做，人就留在扉页 —— 他还能自己从「我的」点进去。
      fail: (e) => console.warn('resume failed:', e.errMsg),
    });
  },

  // returning 要在 onShow 里刷：从录音页提交完回到扉页时，这台设备刚多了一首歌。
  onShow() {
    mode.sync(this);
    this.setData({ returning: library.has() });
  },

  flip() { mode.toggle(this); },

  mine() {
    wx.navigateTo({ url: '/pages/mine/mine' });
  },

  start() {
    if (this._going) return;                 // 连点会往页面栈里压好几个 story
    this._going = true;
    wx.navigateTo({
      url: '/pages/order/order',
      fail: (e) => {
        console.error('navigateTo story failed:', e);
        wx.showModal({ title: '打不开', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },
});
