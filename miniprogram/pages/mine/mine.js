const api = require('../../utils/api.js');
const app = getApp();
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');
const library = require('../../utils/library.js');
const F = require('../../utils/feste.js');

/**
 * 「我的」。这台设备做过的歌，一份曲目单。
 *
 * 借的是歌单的结构 —— 封面、单名、条数，下面密排的曲目 —— 但不是歌单的长相：
 * 没有卡片、没有圆角、没有封面墙，序号是小字衬线，分行靠一根 1rpx 的界栏。
 * 这一页得跟扉页是同一册书，所以封面直接用扉页那顶花环。
 *
 * 先用本地那份画出来，再去服务端要状态。反过来的话，网络慢的那两秒是一张白页，
 * 而这一页的内容其实**本地全都有**，只有"做完了没有"是服务端才知道的。
 */

const MON = ['1 月','2 月','3 月','4 月','5 月','6 月','7 月','8 月','9 月','10 月','11 月','12 月'];

function day(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return `${MON[d.getMonth()]}${d.getDate()} 日`;
}

/** 一条本地记录 → 一行曲目。 */
function row(r, i) {
  const when = day(r.createdAt);
  let name, meta;
  if (r.state === 'done') {
    // 做完了才有歌名 —— 那是成品的一部分
    name = r.title || '无题';
    meta = [r.toName ? `致 ${r.toName}` : '', r.occasion || '', when];
  } else if (r.state === 'failed') {
    name = '这一首没做成';
    meta = [r.occasion || '', when];
  } else {
    // 还在做：不露歌名，用"唱给谁"认这一首，那正是他下单时想的事
    name = r.toName ? `唱给 ${r.toName}` : '新的一首';
    meta = [r.occasion || '', when];
  }
  return {
    id: r.id,
    occasion: r.occasion || '',
    state: r.state || 'making',
    no: String(i + 1).padStart(2, '0'),
    name,
    meta: meta.filter(Boolean).join(' · '),
  };
}

Page({
  data: { mode: '', songs: [], doneCount: 0, face: F.FACE },

  // 返回键和正文起点按胶囊位置算，每台设备不一样，只算一次。
  onLoad() { nav.apply(this); },

  // onShow 不是 onLoad：从作品页返回时那一首可能刚做完，得重画。
  onShow() {
    mode.sync(this);
    this.paint();
    this.refresh();
    this.startFace();
  },

  // 离开这一页就停。定时器不停的话，用户在别的页面上我们还在空转。
  onHide() { clearTimeout(this._face); this._face = null; },
  onUnload() { clearTimeout(this._face); this._face = null; },

  /**
   * 让小丑活着。
   *
   * 停留时长故意不等：平脸待得久，表情一闪而过 —— 等间隔地换表情看着像个
   * 会跳帧的动图，长短不一才像有人在那儿。写死不随机：随机会让同一页每次
   * 进来都不一样，而这是一张画，不是一个特效。
   */
  startFace() {
    clearTimeout(this._face);
    const CYCLE = [
      [F.FACE, 4200], [F.FACE_SMILE, 1800], [F.FACE, 5600], [F.FACE_BLINK, 260],
      [F.FACE, 3400], [F.FACE_WINK, 1500], [F.FACE, 6200], [F.FACE_GRIN, 1600],
      [F.FACE, 4800], [F.FACE_BLINK, 220],
    ];
    let i = 0;
    const tick = () => {
      const [src, ms] = CYCLE[i % CYCLE.length];
      i += 1;
      if (src !== this.data.face) this.setData({ face: src });
      this._face = setTimeout(tick, ms);
    };
    tick();
  },

  paint() {
    // 没做成的不进列表。一首失败的歌摆在「我的」里，用户既点不动也删不掉，
    // 每次打开都提醒他一次做砸了 —— 那不是记录，是一道疤。
    // 本地记录仍然保留（扉页的自动跳转靠 state 判断，见 utils/library.js）。
    const songs = library.list().filter((r) => r.state !== 'failed').map(row);
    this.setData({ songs, doneCount: songs.filter((s) => s.state === 'done').length });
  },

  /** 拿本地这份 id 清单去服务端换状态，回填后重画。 */
  refresh() {
    const ids = library.list().map((x) => x.id);
    if (!ids.length) return;
    api.listOrders(ids, app.globalData.openid)
      .then(({ orders }) => {
        for (const o of orders || []) {
          library.patch(o.id, {
            title: o.title || '',
            toName: o.toName || '',
            occasion: o.occasion || '',
            // 只认换音成品。而 done 却没有成品的那种，是换音失败留下的老状态
            // （pipeline 那条"只能交付原版"的路），原版不交付，所以算没做成。
            state: (o.status === 'failed' || (o.status === 'done' && !o.resultUrl))
              ? 'failed'
              : (o.resultUrl ? 'done' : 'making'),
          });
        }
        this.paint();
      })
      // 网络坏了就留着本地那份。把列表清空是最糟的处理：
      // 用户会以为自己的歌没了。
      .catch(() => {});
  },

  open(e) {
    const { id, occasion } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/song/song?id=${id}&occasion=${encodeURIComponent(occasion || '')}` });
  },

  make() {
    wx.navigateTo({ url: '/pages/story/story' });
  },

  back() {
    // 从扉页进来的正常情况走 navigateBack；万一栈里只有这一页（比如从分享卡片
    // 直接打开），navigateBack 会静默失败，页面卡死在这儿 —— 兜一个回扉页。
    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },
});
