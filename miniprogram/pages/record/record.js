const api = require('../../utils/api.js');
const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const library = require('../../utils/library.js');

const MIN_SECONDS = 12;      // 少于这个长度，音域覆盖不全
const MAX_SECONDS = 30;

let player = null;
const rec = wx.getRecorderManager();
// 试听用的播放器在 onLoad 里建、onUnload 里销毁。模块级创建配 destroy() 的话，
// 第二次进这个页面对象已经销毁，点"听一下"没有任何反应且不报错。

Page({
  data: { occasion: '', theme: '', mode: '', recording: false, elapsed: 0, filePath: '', duration: 0, busy: false },

  onShow() { mode.sync(this); },

  onLoad() {
    player = wx.createInnerAudioContext();
    const oc = app.globalData.draft.occasion || '';
    this.setData({ occasion: oc, theme: theme.slug(oc) });

    rec.onStop((res) => {
      clearInterval(this._t);
      const secs = Math.round((res.duration || 0) / 1000);
      this.setData({ recording: false, filePath: res.tempFilePath, duration: secs });
      if (secs < MIN_SECONDS) {
        wx.showToast({ title: `太短了，唱满 ${MIN_SECONDS} 秒`, icon: 'none' });
      }
    });

    rec.onError((e) => {
      clearInterval(this._t);
      this.setData({ recording: false });
      console.error('recorder error:', e);
      const msg = String(e.errMsg || '');
      wx.showModal({
        title: '录音失败',
        content: /auth|permission|deny/i.test(msg)
          ? `${msg}\n\n没给麦克风权限。右上角 ··· → 设置 → 打开麦克风。`
          : msg || '未知错误',
        showCancel: false,
      });
    });
  },

  onUnload() {
    clearInterval(this._t);
    if (player) { player.destroy(); player = null; }
  },

  toggle() {
    if (this.data.recording) return rec.stop();

    // 采样率、声道、码率都拉满，并且用 camcorder 音源。
    // 默认音源走的是语音通话链路，会开回声消除和降噪 —— 那会削掉 7kHz 以上的
    // “空气感”，而参考录音正是靠那部分决定音色。同一个坑在 erised-artist 的
    // 网页版踩过（getUserMedia 那三个开关必须关），也在 handoff 里踩过
    // （Resemble Enhance 把亮部谐波当噪声抹掉，渲染出来“hella muffled”）。
    // iOS 和 Android 对 audioSource 的实现不一致，这是上真机第一个要 A/B 的点。
    // 顺序很要紧：先把界面切成"录音中"，再去启动录音机。
    // rec.start() 要等权限弹窗和录音设备初始化，是会卡住的；
    // 反过来写的话那段时间界面一帧都不动，用户看到的就是"点了没反应"。
    // 真起不来也不怕：rec.onError 会把状态收回去。
    this.setData({ recording: true, elapsed: 0, filePath: '', duration: 0 });

    // rec.start() 同步抛的时候 rec.onError 是不会触发的 —— 那条失败 toast
    // 永远等不到，界面就停在"已按下"的样子一动不动。必须自己接住。
    // 开发者工具的模拟器根本不支持录音，走的就是这条路。
    try {
      rec.start({
        duration: MAX_SECONDS * 1000,
        sampleRate: 44100,
        numberOfChannels: 1,
        encodeBitRate: 192000,
        format: 'mp3',
        audioSource: 'camcorder',
      });
    } catch (err) {
      this.setData({ recording: false });
      console.error('rec.start threw:', err);
      wx.showModal({
        title: '录音起不来',
        content: `${err.errMsg || err.message || err}\n\n开发者工具的模拟器不支持录音，请点「预览」扫码到手机上测。`,
        showCancel: false,
      });
      return;
    }

    this._t = setInterval(() => {
      const e = this.data.elapsed + 1;
      this.setData({ elapsed: e });
      if (e >= MAX_SECONDS) rec.stop();
    }, 1000);
  },

  play() {
    player.src = this.data.filePath;
    player.play();
  },

  reset() {
    this.setData({ filePath: '', duration: 0, elapsed: 0 });
  },

  async submit() {
    if (this.data.duration < MIN_SECONDS) {
      return wx.showToast({ title: `太短了，唱满 ${MIN_SECONDS} 秒`, icon: 'none' });
    }
    this.setData({ busy: true });
    try {
      // 先建单再传录音：建单会立刻启动写词和出歌，那两步比录音上传慢得多，
      // 早一秒开始就早一秒交付。
      const d = app.globalData.draft;
      // 订阅授权必须在**点击回调**里发起，而且要趁用户正期待结果的这一刻问 ——
      // 放在首屏问会被直接拒掉。一次授权只能发一条，正好够"你的歌做好了"这一条。
      // 模板 ID 现在是空的（测试号没有服务类目、加不了模板），所以这里静默跳过；
      // 注册正式小程序、选好类目拿到模板 ID 之后填进 TMPL 就生效。
      const TMPL = '';
      if (TMPL && wx.requestSubscribeMessage) {
        await new Promise((r) => wx.requestSubscribeMessage({
          tmplIds: [TMPL], complete: r,        // 拒绝也继续，不挡下单
        }));
      }

      const order = await api.createOrder({
        story: d.story, occasion: d.occasion, toName: d.toName, refSong: d.refSong,
        openid: app.globalData.openid || null,
      });
      app.globalData.orderId = order.id;
      await api.uploadVoice(order.id, this.data.filePath);

      // 录音传上去了才算这一单成立，这时才记进本地曲目单。
      // 建单成功就记的话，上传失败的那些会永远挂在"制作中"，
      // 而扉页会拿最近一条没看过的单把人往作品页送 —— 等于把入口堵死。
      library.add({ id: order.id, toName: d.toName || '', occasion: d.occasion || '' });

      wx.redirectTo({ url: `/pages/song/song?id=${order.id}` });   // 等待态就在作品页里
    } catch (e) {
      this.setData({ busy: false });
      wx.showModal({ title: '提交失败', content: String(e.message || e), showCancel: false });
    }
  },
});
