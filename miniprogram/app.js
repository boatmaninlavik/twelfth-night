const api = require('./utils/api.js');

App({
  /**
   * 开局就把 openid 拿到。它只用于一件事：歌做好时给用户发订阅消息。
   * 拿不到也不影响做歌 —— 只是收不到通知，用户下次打开照样看得到歌。
   */
  onLaunch() {
    this.loadFont();
    wx.login({
      success: ({ code }) => {
        if (!code) return;
        api.session(code)
          .then((r) => { this.globalData.openid = r.openid || null; })
          .catch(() => {});
      },
    });
  },

  /**
   * 自带宋体。
   *
   * 界面用系统宋体时，macOS 和 iOS 渲染出来不一样 —— 开发者工具里排好的一屏，
   * 到 iPhone 上字形和字重都变了。自己带字体是唯一能两边一致的办法。
   *
   * 两个字重都加载，不让系统去合成粗体：合成算法各平台不同，那正是要消除的东西。
   * global: true 才能给所有页面用，只在当前页生效的话跳一次页就没了。
   *
   * 失败不做任何处理：字体栈里后面还有 Songti SC，加载不到就退回系统字体，
   * 界面照常能用。为它加重试或提示都是把小事做大。
   */
  loadFont() {
    const base = require('./utils/api.js').BASE;
    for (const w of ['400', '600']) {
      wx.loadFontFace({
        family: 'TN Serif',
        source: `url("${base}/font/tn-serif-${w}.ttf")`,
        desc: { weight: w },
        global: true,
        scopes: ['webview'],
        success: () => console.log(`[font] ${w} 就位`),
        fail: (e) => console.warn(`[font] ${w} 加载失败`, e.errMsg),
      });
    }
  },

  globalData: {
    // 一次下单的全部状态，页面间靠它传递。内测阶段够用；
    // 真要多单并行再换成每页 query 带 orderId。
    openid: null,
    draft: { occasion: '', story: '', toName: '', refSong: null },
    orderId: null,
  },
});
