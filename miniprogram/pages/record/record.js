const api = require('../../utils/api.js');
const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const library = require('../../utils/library.js');
const consent = require('../../utils/consent.js');
const voice = require('../../utils/voice.js');
const nav = require('../../utils/nav.js');

const MIN_SECONDS = 12;      // 少于这个长度，音域覆盖不全
const MAX_SECONDS = 30;

/**
 * 当时让用户唱的是什么 —— 存证里要记下来，用来证明这是现场录制。
 *
 * ⚠️ 授权书 1.1 说的是「现场录制」，这套流程做得到：全程只走
 * getRecorderManager，没有任何上传音频文件的入口 —— 那是最要紧的一道风险闸门。
 * 但原始文档里还提到一条更强的：**现场朗读随机文本**。
 * 那要改录音脚本（比如先念一组随机数字再唱音阶），会改变送进换声模型的音频，
 * 属于产品决定，没有在这一版里自作主张加。真要加，把这个常量改成随机生成即可，
 * 存证字段本身不用动。
 */
// 这个串是**存证**：它记的是"我们当时让用户做了什么"，会随同意记录一起落库。
// 所以屏幕上的音阶一改，这里必须跟着改 —— 否则那份存证描述的是另一次录音，
// 真要拿出来对质的时候，它证明不了任何事。
// 两种录法并存：唱自己熟悉的歌放得开、不尴尬；音阶的音域覆盖更全，换声更稳。
// 存证里记的是**他实际选的那一种**，不是默认值。
const PROMPTS = {
  own:   '唱一段自己熟悉的歌，哪一段都行，约二十秒',
  scale: '跟着唱一遍：do re mi fa sol la si do / do si la sol fa mi re do'
       + '（从最低唱到最高再唱回来，约二十秒）',
};

let player = null;
const rec = wx.getRecorderManager();
// 试听用的播放器在 onLoad 里建、onUnload 里销毁。模块级创建配 destroy() 的话，
// 第二次进这个页面对象已经销毁，点"听一下"没有任何反应且不报错。

/**
 * 声音。这一页有两个法律上要紧的时刻，都在这儿，所以两层授权都落在这一页：
 *
 *   按下录音键之前 → 第一层，敏感个人信息的「单独同意」
 *   点「就用这段」 → 第二层，声音使用授权书，电子签、留存证
 *
 * 条款全文和存证的装配在 utils/consent.js。这里只管三件事：
 * 什么时候弹、拒绝了怎么办、同意之后把存证送出去。
 *
 * 拒绝第一层**不挡下单** —— 弹窗里白纸黑字写着「你仍然可以下单」，
 * 写了就得真做到，所以有 useOwnVoice 这条分支。
 * 这也不只是体面：《个人信息保护法》不允许因为拒绝提供非必需的敏感信息
 * 就拒绝提供服务，而这首歌用歌手音色照样做得出来。
 */
Page({
  data: {
    occasion: '', theme: '', mode: '',
    recording: false, elapsed: 0, filePath: '', duration: 0, busy: false,

    // 录音方式。两种都行，存证里记他实际选的那一种。
    take: 'own',           // 'own' 唱自己的歌 | 'scale' 跟着音阶

    // 授权。一份文件、一次勾选，在**按下录音键之前**问。
    useOwnVoice: true,     // 被拒之后翻成 false，走歌手音色那条路
    consented: false,      // 已同意（这台设备、当前条款版本）
    sheet: false,          // 授权纸开着没有
    doc: null, docTitle: '',
    checks: [], allChecked: false, canRevoke: false,
    readonly: false,       // 回来读一遍，不是来签的

    // 声音档案。有档案就不必重录，直接用（utils/voice.js）
    hasVoice: false, voiceWhen: '', voiceDur: 0, voiceLeft: 0,
  },

  onShow() { mode.sync(this); },

  onLoad() {
    nav.apply(this);              // 返回键和正文起点，对齐右上角胶囊
    player = wx.createInnerAudioContext();
    const oc = app.globalData.draft.occasion || '';
    this.setData({
      occasion: oc,
      theme: theme.slug(oc),
      consented: !consent.needs(),
    });

    // 先用本机缓存的那份画出来，再去服务端核对 —— 网络慢的那两秒不该是一张
    // 「请录音」的空页，那会让第二次来的人以为上次白录了。
    // 跟 mine.js 先画本地再刷新是同一个道理。
    this.showProfile(voice.read());
    this.syncProfile();

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


  /**
   * 返回故事页。
   *
   * 录音中就先停掉 —— 带着一个还在跑的录音器离开页面，
   * onStop 回调会打到一个已经卸载的页面实例上。
   */
  back() {
    if (this.data.recording) { try { rec.stop(); } catch (e) { /* 本来就没在录 */ } }
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },


  /* ── 声音档案 ────────────────────────────────────── */

  /**
   * 把档案画到界面上。
   * 过期的一律当没有 —— 宁可让人重录，不可超期使用：
   * 「12 个月到期自动删除」是授权书 3.1 写死的一句。
   */
  showProfile(p) {
    if (!voice.valid(p)) {
      this._profile = null;
      return this.setData({ hasVoice: false, voiceWhen: '', voiceDur: 0, voiceLeft: 0 });
    }
    this._profile = p;
    this.setData({
      hasVoice: true,
      voiceWhen: voice.when(p),
      voiceDur: p.durationSec || 0,
      voiceLeft: voice.daysLeft(p),
    });
  },

  /** 去服务端核对。拿不到就留着本地那份，别把界面清空。 */
  syncProfile() {
    api.getVoice(app.globalData.openid, voice.token())
      .then(({ voice: p }) => {
        voice.save(p || null);
        this.showProfile(p || null);
      })
      // 网络坏了就用本地那份。清空是最糟的处理：用户会以为自己的录音没了，
      // 然后又录一遍 —— 于是 bucket 里多一份、撤回时删不干净。
      .catch(() => {});
  },

  /** 重录：把档案先从界面上撤下来，走一遍第一次的流程。 */
  reRecord() {
    this.setData({ hasVoice: false, filePath: '', duration: 0, elapsed: 0 });
  },

  useSinger() {
    this.setData({ useOwnVoice: false, hasVoice: false, filePath: '', duration: 0 });
  },


  /* ── 授权书 ──────────────────────────────────────── */

  noop() {},

  /** 页脚的常驻入口。已经同意过的，进来能看见「撤回」。 */
  openL1() { this.openSheet(); },

  /**
   * 授权书的只读入口。
   *
   * 授权书 6.3 写着「可随时在录音页的『授权说明』内查看」—— 那就得真有地方看。
   * 只读态里勾选框和签署键都不出现：一份已经签过的文件再摆一次勾选框，
   * 是在诱导重复签署。
   */
  openL2Read() { this.openSheet(true); },

  openSheet(readonly) {
    const doc = consent.DOC;
    this._shownAt = Date.now();       // 展示时长：秒开秒关的同意是站不住的
    this._readEnd = false;
    this.setData({
      sheet: true,
      doc,
      readonly: !!readonly,
      docTitle: String(doc.title).replace(/\{br\}/g, '\n'),
      // 默认一个都不勾。这一条是硬要求，不是风格。
      checks: doc.checks.map(() => false),
      allChecked: false,
      canRevoke: !consent.needs(),
    });
  },

  closeSheet() { this.setData({ sheet: false, doc: null, readonly: false }); },

  /** 「滚动到底」—— 证明用户有机会读完全文，成本几乎为零的一条存证。 */
  onReadEnd() { this._readEnd = true; },

  /**
   * 选录音方式。换了之后**已录的那一条作废** ——
   * 存证里记的提示语必须和他实际唱的那一次对得上；留着上一种录法的音频，
   * 那份存证描述的就是另一回事了。
   */
  pickTake(e) {
    const k = e.currentTarget.dataset.k || 'own';
    if (k === this.data.take) return;
    this._md5 = null; this._bytes = null;
    this.setData({ take: k, filePath: '', duration: 0, elapsed: 0 });
  },

  toggleCheck(e) {
    const i = Number(e.currentTarget.dataset.i);
    const checks = this.data.checks.slice();
    checks[i] = !checks[i];
    this.setData({ checks, allChecked: checks.every(Boolean) });
  },

  /**
   * 没勾满就说清楚差哪一条，别做成一个按下去没反应的死按钮。
   * 死按钮在这儿尤其糟：用户会以为是程序坏了，而不是自己漏了一勾。
   */
  agree() {
    const { checks, doc } = this.data;
    if (!checks.length || !checks.every(Boolean)) {
      const i = checks.findIndex((c) => !c);
      return wx.showToast({ title: `还差一条：${doc.checks[i]}`, icon: 'none' });
    }
    const ev = consent.evidence({
      version: doc.version,
      checks: checks.slice(),
      shownAt: this._shownAt,
      readEnd: this._readEnd,
      // 记下他当时选的是哪一种录法 ——「现场录制」那句声明指的就是这一次。
      extra: { prompt: PROMPTS[this.data.take], take: this.data.take },
    });
    consent.save(ev);
    this.setData({ consented: true, useOwnVoice: true });
    this.closeSheet();
    this.startRec();          // 按钮上写的是「同意，开始录音」，就得真开始
  },

  decline() {
    // 拒绝：翻到歌手音色那条路。不弹二次挽留 ——
    // 在敏感个人信息这一处反复劝，本身就是不该有的设计。
    this.closeSheet();
    this.setData({ useOwnVoice: false, filePath: '', duration: 0, elapsed: 0 });
  },

  /**
   * 撤回。
   *
   * 「随时可以撤回」写在条款里而界面上没有入口，那句话就是假的，
   * 所以这条路一直在授权说明那张纸上开着。
   * 本地先清干净；已经建过单的，再让服务端删掉那份录音。
   */
  revoke() {
    wx.showModal({
      title: '撤回授权',
      content: '会删掉你的声音档案和这台设备上的同意记录。已经做好的歌还是你的，不受影响。',
      confirmText: '撤回',
      success: ({ confirm }) => {
        if (!confirm) return;
        consent.clear();
        voice.clear();
        // 删档案本体（连同 bucket 里那个文件）。撤回删的是**档案**不是**订单**——
        // 授权书 3.4：撤回不影响撤回前已完成的交付，已交付的成品归授权人所有。
        api.deleteVoiceProfile(app.globalData.openid, voice.token())
          .catch((e) => console.warn('删除声音档案失败:', e.message));
        // 这一单如果已经建了、录音已经挂上去了，那一份也要删。
        const id = app.globalData.orderId;
        if (id) api.deleteVoice(id).catch((e) => console.warn('删除本单录音失败:', e.message));
        this.closeSheet();
        this.setData({
          consented: false, useOwnVoice: false, hasVoice: false,
          filePath: '', duration: 0, elapsed: 0,
        });
        wx.showToast({ title: '已撤回', icon: 'none' });
      },
    });
  },

  /**
   * 下单时随单送出的那一份：在**已签的那条同意**之上，补这一单实际的录音信息。
   * 用户只点过一次，但每一单都要有自己的记录。
   */
  _grantExtra() {
    const p = this._profile;
    const reuse = this.data.useOwnVoice && this.data.hasVoice;
    return {
      prompt: PROMPTS[this.data.take],
      take: this.data.take,
      // 跟 doSubmit 里那个 useOwn 必须是同一个式子：存证里记的得是
      // 这一单**实际**怎么做的，不是界面上当时的开关长什么样。
      useOwnVoice: this.data.useOwnVoice && (reuse || !!this.data.filePath),
      // 用的是旧档案还是这次新录的 —— 这一项决定了「现场录制」那句声明
      // 指的是哪一次录制，所以要连档案的建档时间一起记下来。
      reusedProfile: reuse,
      profileCreatedAt: reuse && p ? p.createdAt : null,
      audioMd5: reuse ? (p && p.audioMd5) || null : (this._md5 || null),
      audioBytes: reuse ? null : (this._bytes || null),
      durationSec: reuse ? (p && p.durationSec) || null : (this.data.duration || null),
    };
  },


  /* ── 录音 ────────────────────────────────────────── */

  /** 录音键。没同意过就先弹第一层 —— 采集之前问，不是采集之后。 */
  toggle() {
    if (this.data.recording) return rec.stop();
    if (consent.needs()) return this.openSheet();
    this.startRec();
  },

  startRec() {
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
    this._md5 = null; this._bytes = null;

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
    this._md5 = null; this._bytes = null;
    this.setData({ filePath: '', duration: 0, elapsed: 0 });
  },


  /* ── 提交 ────────────────────────────────────────── */

  /**
   * 「就用这段」不再直接下单 —— 先签第二层。
   * 下单这一下正是授权书生效的时刻，所以这两件事必须是同一个动作。
   */
  submit() {
    if (this.data.busy) return;
    const reuse = this.data.useOwnVoice && this.data.hasVoice;

    // 没交声音的那条路直接下单。
    if (!this.data.useOwnVoice || (!reuse && !this.data.filePath)) return this.doSubmit();
    // 用旧档案的这一单也直接走：录音没变，哈希取自档案。
    if (reuse) return this.doSubmit();

    if (this.data.duration < MIN_SECONDS) {
      return wx.showToast({ title: `太短了，唱满 ${MIN_SECONDS} 秒`, icon: 'none' });
    }
    // 录音哈希：证明后续用的样本和签署时那一份是同一个。
    // 原来这一步能趁用户读第二张纸的十几秒算完；现在只有一份授权、
    // 而且早在录音前就签过了，所以必须**等它回来再下单**。
    // 算不出来也继续 —— 存证少一项，好过让用户交不了单。
    this.setData({ busy: true });
    this.hashTake(() => this.doSubmit());
  },

  hashTake(done) {
    const go = () => { if (done) done(); };
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath: this.data.filePath,
        digestAlgorithm: 'md5',
        success: (r) => { this._md5 = r.digest || null; this._bytes = r.size || null; },
        // 哈希拿不到不该挡住下单：存证少一项，总好过用户交不了单
        fail: (e) => console.warn('getFileInfo 失败:', e.errMsg),
        complete: go,
      });
    } catch (e) {
      console.warn('getFileInfo threw:', e);
      go();
    }
  },

  async doSubmit() {
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

      const reuse = this.data.useOwnVoice && this.data.hasVoice;
      const useOwn = this.data.useOwnVoice && (reuse || !!this.data.filePath);
      /* 按单留证。用户只签过一次，但每一单都要有自己的那条记录。
         做法是在**已签的那条存证**上补这一单的录音信息，而不是重新
         evidence() 一份 —— 重新生成会把 signedAt 改成下单时间，
         那等于伪造签署时刻，是这套东西里最不能出的错。 */
      const signed = consent.read();
      const grant = signed
        ? { ...signed, ...this._grantExtra(), boundAt: new Date().toISOString() }
        : null;
      if (grant) consent.saveGrant(grant);
      const order = await api.createOrder({
        story: d.story, occasion: d.occasion, toName: d.toName, refSong: d.refSong,
        openid: app.globalData.openid || null,
        // 服务端据此决定这一单要不要等录音：不等的那些直接交付原版，
        // 否则订单会永远停在 awaiting_voice，用户看到的是一首永远做不完的歌。
        useOwnVoice: useOwn,
        // 用旧档案的单不上传录音，服务端自己去档案里取那份 voice_path。
        reuseVoice: reuse,
        deviceToken: voice.token(),
        // 存证随单落库。授权书本身不重要，能证明"这个人在这个时间确实同意了"才重要。
        consent: [grant].filter(Boolean),
      });
      app.globalData.orderId = order.id;

      if (useOwn && !reuse) {
        // 这一步服务端顺手建档（或者换掉旧档），把新档案带回来存到本机。
        const r = await api.uploadVoice(order.id, this.data.filePath, {
          deviceToken: voice.token(),
          durationSec: this.data.duration,
          audioMd5: this._md5,
        });
        if (r && r.voice) voice.save(r.voice);
      }

      // 录音传上去了才算这一单成立，这时才记进本地曲目单。
      // 建单成功就记的话，上传失败的那些会永远挂在"制作中"，
      // 而扉页会拿最近一条没看过的单把人往作品页送 —— 等于把入口堵死。
      library.add({ id: order.id, toName: d.toName || '', occasion: d.occasion || '' });

      // 这一单成立了，草稿就用完了。不清的话，从「我的」再点「做一首」进故事页，
      // 会带着上一首的故事直接落到合稿页 —— 用户会以为自己的新歌被串了。
      app.globalData.draft = { occasion: '', story: '', toName: '', refSong: null };

      wx.redirectTo({ url: `/pages/song/song?id=${order.id}` });   // 等待态就在作品页里
    } catch (e) {
      this.setData({ busy: false });
      wx.showModal({ title: '提交失败', content: String(e.message || e), showCancel: false });
    }
  },
});
