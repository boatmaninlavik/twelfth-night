const api = require('../../utils/api.js');
const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');
const F = require('../../utils/feste.js');
const library = require('../../utils/library.js');

/**
 * 作品页。一页两态：**做歌中**和**做好了**，同一个页面里换数据，不跳转。
 *
 * 为什么不做成两个页面：跳转会有一次白屏和一次动画，把"歌到了"这件事切成两段。
 * 同一页里换数据的话，等待时那颗转着的星，就是成品页上那个播放键 ——
 * 它只是停下来变得可以按。这一下是整个产品最值得做好的瞬间。
 *
 * 做歌中不显示歌名和歌词：那是成品的一部分，提前露出来就把惊喜拆了。
 */

// 播放器在 onLoad 里建、onUnload 里销毁。
// 原来是模块级 `const player = wx.createInnerAudioContext()` 配 onUnload 里 destroy()——
// 第二次进这个页面时对象已经是销毁状态，给它设 src 静默无效，点播放一点声音都没有，
// 也不报错。第一次进能响、之后再进全哑，只有复访才暴露。
let player = null;

// 跟扉页同一颗星：四长八短，十二道芒。
const RAYS = [
  { deg: 0,   long: true  },
  { deg: 90,  long: true  },
  { deg: 30,  long: false },
  { deg: 60,  long: false },
  { deg: 120, long: false },
  { deg: 150, long: false },
];

/**
 * 等待时的那句话。
 *
 * 说的是小丑费斯特 —— 《第十二夜》里唯一清醒的人，也是剧中真正唱歌的那个。
 * 别人喝醉、错认、装疯，只有他在旁边弹琴唱真话。让他来替用户等这首歌，
 * 比一句"正在生成中"贴切得多。
 *
 * 晚上九点之后换一句：那个点还在等一首歌的人，多半是要送人的，
 * 而"夜幕降临"这四个字跟剧名本身是同一个意象。
 */
const CLOWN_LINES = [
  '小丑正拨响他的电吉他，{{BR}}编织属于你的主打歌',
  '小丑正按下黑白琴键，{{BR}}将你的心事揉进旋律',
];
const NIGHT_LINE = '夜幕降临，{{BR}}音乐正在升起';

/**
 * 状态词的"闪词"。
 *
 * 真实阶段（正在谱曲 / 正在写词 …）每隔几秒被一个近义的手艺词替一下，一秒多之后
 * 换回来。这一下的作用不是传递信息 —— 信息由真实阶段负责 —— 而是让人相信
 * 那头真的有人在忙。一个纹丝不动的"正在谱曲"看久了像卡死了。
 *
 * 用词都往手艺上靠：推敲、调弦、落笔。不用"生成中""处理中"那种机器话。
 */
/**
 * 飘在小丑身边的花瓣。
 *
 * 每片的起始角度、半径、周期、大小都不一样 —— 整齐排布的一圈一眼就是程序画的。
 * 参数写死不随机：随机会让同一页每次进来都不同，而这是一张画，不是一个特效。
 */
/**
 * 绕着小丑飘的叶片。
 *
 * 全部白色、全部叶形，**不掺花** —— 花的橙和粉会跟小丑那身朱砂抢，
 * 一屏两个彩色主角就散了。白叶只是他周围的空气。
 *
 * 轨道半径 118-176rpx。第一版给到 186-264rpx，有几片直接飘出屏幕外了。
 *
 * 每片的半径、起始角、周期、大小、自转都不同，而且写死不随机：
 * 整齐排一圈一眼就是程序画的；而随机会让同一页每次进来都不一样，
 * 这是一张画，不是一个特效。
 */
const PETALS = [
  { k: 1, r: 128, a:  18, dur: 30, size: 26, tilt:  12 },
  { k: 2, r: 168, a: 132, dur: 38, size: 20, tilt: -24 },
  { k: 3, r: 142, a: 254, dur: 34, size: 23, tilt:  40 },
  { k: 4, r: 176, a:  78, dur: 44, size: 16, tilt: -10 },
  { k: 5, r: 118, a: 300, dur: 27, size: 21, tilt:  28 },
  { k: 6, r: 156, a: 200, dur: 41, size: 18, tilt: -34 },
].map((p) => ({
  ...p,
  src: F.PETAL_W,
  style: `width:${p.size * 2}rpx;height:${p.size}rpx;`
       + `animation-duration:${p.dur}s;animation-delay:-${p.dur * (p.a / 360)}s;`
       + `--r:${p.r}rpx;--tilt:${p.tilt}deg;`,
}));

const FLAVOR = ['正在推敲', '正在调弦', '正在落笔', '正在斟酌', '正在誊写', '正在试唱'];

function clownLine(seed) {
  const h = new Date().getHours();
  // 九点到凌晨五点算夜里
  const line = (h >= 21 || h < 5)
    ? NIGHT_LINE
    : CLOWN_LINES[Math.abs(seed) % CLOWN_LINES.length];
  return line.replace('{{BR}}', '\n');
}

// 做歌各阶段的进度和说法。进度是假的（拿不到真百分比），但顺序是真的 ——
// 用户看到的是"走到哪一步"，不是一个乱跳的数字。所以不摆百分号。
const STEPS = {
  created:        { pct: 6,   text: '正在读你的故事' },
  writing:        { pct: 18,  text: '正在写词' },
  generating:     { pct: 38,  text: '正在谱曲' },
  generated:      { pct: 52,  text: '曲子有了，正在分轨' },
  separating:     { pct: 60,  text: '正在分轨' },
  awaiting_voice: { pct: 70,  text: '正在把你的声音放进去' },
  converting:     { pct: 84,  text: '正在把你的声音放进去' },
  done:           { pct: 100, text: '好了' },
};

Page({
  data: {
    occasion: '', theme: '', mode: '', rays: RAYS,
    ready: false,                      // false = 做歌中，true = 成品
    pct: 6, step: '正在读你的故事', failed: false, errMsg: '', clown: '', body: F.BODY, armL: F.ARM_L, armR: F.ARM_R, hat: F.HAT, petals: PETALS,
    title: '', byline: '', lyrics: '', playing: false,
    loading: false, audioErr: '',
    synced: false, lines: [], active: -1, anchor: '',
    angle: 0, scrubbing: false,        // 指针角度（0 = 正北），以及是不是正被手指拖着
  },

  onShow() { mode.sync(this); },

  onLoad(q) {
    nav.apply(this);          // 返回键和正文起点按胶囊位置算
    this._id = q.id || app.globalData.orderId;

    // 那句话按订单 id 定，同一单每次进来都是同一句，不会来回跳。
    let seed = 0;
    for (const ch of String(this._id || '')) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
    this.setData({ clown: clownLine(seed) });

    // 演示模式：?demo=1 只看等待界面，不下单、不轮询、不花钱。
    // 开发者工具里加一个编译模式，页面填 pages/song/song，参数填 demo=1 就能看。
    if (q.demo) {
      this._realStep = q.step || '正在谱曲';
      this.setData({ occasion: q.occasion || '', theme: theme.slug(q.occasion || ''),
                     pct: Number(q.pct) || 38, step: this._realStep });
      return this.startFlavor();
    }

    player = wx.createInnerAudioContext();
    // 从「我的」或扉页自动跳回来时，globalData.draft 是空的（那是这次会话里
    // 刚填过表才有的东西），场合得由 query 带过来，否则整页丢掉那点主题色。
    const oc = q.occasion || app.globalData.draft.occasion || '';
    this.setData({ occasion: oc, theme: theme.slug(oc) });

    player.onTimeUpdate(() => this.onTime(player.currentTime));
    player.onPlay(() => this.setData({ playing: true }));
    player.onPause(() => this.setData({ playing: false }));
    player.onEnded(() => this.setData({ playing: false }));
    // 把真实错误显示出来。之前只弹一句"播放失败"，等于没有信息 ——
    // 域名没进白名单、链接过期、文件解不开，症状都是"点了没声音"，
    // 但处理方式完全不同。
    player.onError((e) => {
      console.error('audio error', e);
      this.setData({ playing: false, audioErr: e.errMsg || JSON.stringify(e) });
      wx.showModal({
        title: '播放失败',
        content: String(e.errMsg || JSON.stringify(e)),
        showCancel: false,
      });
    });
    player.onWaiting(() => this.setData({ loading: true }));
    player.onCanplay(() => {
      this.setData({ loading: false });
      // duration 要等音频头解出来才有。没有它就画不出"走满一圈"这件事，
      // 所以在这里取，而不是在 setData 成品那一刻取（那时还是 0）。
      if (player.duration > 0) this._dur = player.duration;
    });

    this.poll();
    // 8 秒一次。做一首歌要几分钟，更密的轮询只是白费流量和电。
    this._t = setInterval(() => this.poll(), 8000);
    this.startFlavor();
  },

  /** 每 5 秒把状态词闪成一个手艺词，1.4 秒后换回真实阶段。 */
  startFlavor() {
    this._flavor = setInterval(() => {
      if (this.data.ready || this.data.failed) return;
      const w = FLAVOR[Math.floor(Math.random() * FLAVOR.length)];
      this.setData({ step: w });
      setTimeout(() => {
        if (!this.data.ready && !this.data.failed) {
          this.setData({ step: this._realStep || w });
        }
      }, 1400);
    }, 5000);
  },

  onUnload() {
    clearInterval(this._t);
    clearInterval(this._flavor);
    if (player) { player.destroy(); player = null; }
  },

  async poll() {
    let o;
    try {
      o = await api.getOrder(this._id);
    } catch (e) {
      return;                          // 网络抖动不改界面，下一轮再说
    }

    // done 却没有成品 = 失败。换音那一步出错时 pipeline 走的是"只能交付原版"
    // 那条老路，它留下的是 status:'done' + error + 没有 result_url。
    // 而原版不交付，所以对用户来说这就是没做成 —— 只认 status==='failed' 的话，
    // 这一单会永远停在等待页上转。
    if (o.status === 'failed' || (o.status === 'done' && !o.resultUrl)) {
      clearInterval(this._t); this._t = null;
      library.patch(this._id, { state: 'failed' });
      return this.setData({ failed: true, errMsg: o.error || '请重试' });
    }

    if (!o.resultUrl) {
      // 只认换音成品。Suno 原版不是交付物 —— 让用户先听到它，
      // 等于告诉他"你的声音是后加上去的"。
      const s = STEPS[o.status] || { pct: 45, text: '正在制作' };
      if (s.text !== this._realStep) {
        this._realStep = s.text;
        this.setData({ pct: s.pct, step: s.text });
      }
      return;
    }

    // ── 成品到了。同一页换数据，不跳转。 ──
    clearInterval(this._t); this._t = null;
    clearInterval(this._flavor); this._flavor = null;

    // 回写本地曲目单。seen 是本地权威的那一位：它一置上，扉页就不再把人
    // 自动送回这一页了 —— 他已经看到成品了，这一趟的使命完成了。
    library.patch(this._id, {
      state: 'done', seen: true,
      title: o.title || '', toName: o.toName || '',
    });

    player.src = o.resultUrl;
    this.setData({
      ready: true,
      pct: 100,
      title: o.title || '无题',
      byline: o.toName ? `致 ${o.toName}` : '',   // 唱片扉页的写法，不写"谁唱给谁"
      lyrics: o.lyrics || '',
      ...this.buildLyrics(o.lyricLines),
    });
  },

  /**
   * 对齐结果 → 面板数据。
   *
   * 判不过就退回整段纯歌词。对齐器算不准时给出的是"看起来对但错半拍"的时间戳，
   * 而人会跟着高亮读 —— 错的同步比没有同步更糟。
   */
  buildLyrics(ll) {
    if (!ll || !Array.isArray(ll.lines) || !ll.lines.length) return { synced: false };

    const aligned = ll.lines.filter((l) => l.start !== null && l.start !== undefined);
    if (aligned.length < 4) return { synced: false };
    if (aligned.length / ll.lines.length < 0.7) return { synced: false };

    // 用中位数不用平均数。实测置信度是双峰的：重复的副歌那几行接近 0（模型分不清
    // 是第几遍），其余在 0.4-0.7。平均值被那一簇零拽下来，会把一份时间戳完全单调、
    // 覆盖全曲的好对齐判死。
    const cs = aligned.map((l) => l.confidence || 0).sort((a, b) => a - b);
    if (cs[cs.length >> 1] < 0.25) return { synced: false };

    // 时间必须单调。倒退说明对齐器跑飞了。
    for (let i = 1; i < aligned.length; i++) {
      if (aligned[i].start < aligned[i - 1].start) return { synced: false };
    }

    const lines = aligned.map((l, i) => ({ index: i, text: l.text, start: l.start, end: l.end }));
    this._starts = lines.map((l) => l.start);
    return { synced: true, lines, active: -1, anchor: '' };
  },

  /**
   * 播放位置推进。一次 setData 同时管两件事：指针的角度、和该亮哪一行。
   *
   * 拆成两次 setData 的话，每秒就要穿四次桥变八次。歌词那一份只在**换行**
   * 时才写（二分找行，不能线性扫），指针那一份每次都要写 —— 合成一个补丁发。
   */
  onTime(t) {
    if (this.data.scrubbing) return;          // 手指按着的时候，位置归手指管
    const patch = {};

    const dur = this._dur || player?.duration || 0;
    if (dur > 0) {
      const deg = (t / dur) * 360;
      // 只在角度真的变了才写。onTimeUpdate 有时会连报同一个时间点。
      if (Math.abs(deg - this.data.angle) > 0.15) patch.angle = deg;
    }

    if (this._starts) {
      let lo = 0, hi = this._starts.length - 1, idx = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (this._starts[m] <= t) { idx = m; lo = m + 1; } else { hi = m - 1; }
      }
      if (idx !== this.data.active) {
        patch.active = idx;
        patch.anchor = idx >= 0 ? `L${idx}` : '';
      }
    }
    if (Object.keys(patch).length) this.setData(patch);
  },

  /**
   * 按住指针转 = 拖到歌里的任意位置。
   *
   * 圆心要在**触摸开始的那一刻**去量：boundingClientRect 给的是视口坐标，
   * 而这一页是能滚的，缓存下来的圆心滚一下就错了。查询是异步的，
   * 拿到之前的 move 直接丢掉 —— 手指刚按下的头几毫秒不动也不影响手感。
   */
  clockStart(e) {
    if (!this.data.ready) return;
    this._cc = null;
    this._moved = false;
    this._touch0 = e.touches[0];
    wx.createSelectorQuery().in(this).select('.crest').boundingClientRect((r) => {
      if (r) this._cc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }).exec();
  },

  clockMove(e) {
    if (!this._cc || !this.data.ready) return;
    const p = e.touches[0];
    // 位移太小当成点击，不当拖动 —— 手指按下去总会抖那么几像素。
    if (!this._moved) {
      const d = Math.hypot(p.clientX - this._touch0.clientX, p.clientY - this._touch0.clientY);
      if (d < 6) return;
      this._moved = true;
      this.setData({ scrubbing: true });
    }
    // 指针朝正北是 0 度、顺时针为正，所以是 atan2(dx, -dy) 不是 atan2(dy, dx)。
    const deg = (Math.atan2(p.clientX - this._cc.x, this._cc.y - p.clientY) * 180 / Math.PI + 360) % 360;
    this.setData({ angle: deg });
  },

  clockEnd() {
    if (!this._moved) return;                 // 没拖动就是一次点击，交给 catchtap 的 toggle
    this._moved = false;
    const dur = this._dur || player?.duration || 0;
    this.setData({ scrubbing: false });
    if (dur > 0 && player) player.seek((this.data.angle / 360) * dur);
  },

  /** 回「我的」。 */
  back() {
    const stack = getCurrentPages();
    const prev = stack[stack.length - 2];
    // 从「我的」点进来的就退回去，别在栈里再压一层同样的页；
    // 从录音页 redirect 过来的（栈里没有「我的」）就正常跳。
    if (prev && prev.route === 'pages/mine/mine') wx.navigateBack();
    else wx.navigateTo({ url: '/pages/mine/mine' });
  },

  seek(e) {
    const t = e.currentTarget.dataset.t;
    if (typeof t !== 'number' || !player) return;
    player.seek(t);
    if (!this.data.playing) this.toggle();
  },

  toggle() {
    if (!this.data.ready) return;
    if (!player || !player.src) {
      return wx.showModal({ title: '还没有音频', content: '成品链接是空的，刷新一下这一页',
                            showCancel: false });
    }
    // 先翻界面再调播放器。playing 本来只由 onPlay 回调置位，而那个回调要等音频
    // 缓冲好才触发 —— 中间一两秒按钮毫无反应。onPlay/onPause/onError 仍会纠正。
    const next = !this.data.playing;
    this.setData({ playing: next });
    next ? player.play() : player.pause();
  },

  again() { wx.reLaunch({ url: '/pages/index/index' }); },
});
