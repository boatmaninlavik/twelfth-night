const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');

/**
 * 定歌，第二步：故事。
 *
 * 原来这一页什么都装 —— 故事、唱给谁、场合、参考歌。太长，而且主次不分：
 * 故事是这首歌的**内容**，另外三样只是它的边框，可它们长得一模一样。
 * 现在前三样在 pages/order，这一页只剩这一件事，所以它可以占满一屏。
 */
Page({
  data: {
    // storyText 只在失焦时回填一次，用来在非编辑态把文字显示出来；
    // 打字过程中的实时值在 this._story 里，不进 data（否则每敲一个字 setData 一次）
    writing: false, storyText: '',
    theme: '', mode: '',
  },

  onLoad() {
    nav.apply(this);
    const d = app.globalData.draft || {};
    this._story = d.story || '';
    this.setData({ storyText: this._story, theme: theme.slug(d.occasion || '') });
  },

  onShow() { mode.sync(this); },

  startWriting() { this.setData({ writing: true }); },   // 挂上 textarea，focus 属性会自动聚焦
  onStory(e) { this._story = e.detail.value; },          // 打字过程中不 setData
  stopWriting(e) {
    // 失焦即卸载 textarea —— 页面上不留原生图层，下面的东西才点得动
    this._story = e.detail.value;
    this.setData({ writing: false, storyText: this._story });
  },

  next() {
    const story = (this._story || '').trim();
    if (!story) return wx.showToast({ title: '先说说这个人/事', icon: 'none' });
    // 连点两下会压两个 record 页进栈；页面栈上限是 10，
    // 攒满之后 navigateTo 直接失败 —— 而失败是没有任何提示的。
    if (this._going) return;
    this._going = true;

    app.globalData.draft = { ...(app.globalData.draft || {}), story };
    wx.navigateTo({
      url: '/pages/record/record',
      // 必须有 fail：navigateTo 失败时什么都不会发生，界面上完全看不出来，
      // 表现就是"按钮点不动"。页面栈溢出、路径写错都会走到这儿。
      fail: (e) => {
        this._going = false;
        console.error('navigateTo record failed:', e);
        wx.showModal({ title: '打不开录音页', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },

  back() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/order/order' }) });
  },
});
