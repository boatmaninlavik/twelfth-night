/**
 * 故事页 · 2b 圆签方案。
 *
 * 这是和 pages/story（2c 一条线）**并行的另一版**，只为在模拟器上对比。
 * 两版共用 utils/cues.js 的题池，正式流程走的仍然是 pages/story。
 * 要打开这一版：开发者工具「编译模式」里选「2b 圆签」。
 *
 * 和 2c 的区别不在长相，在**结构**：
 *   一条线  给的是「歌的形状」—— 三节按次序，有引导性，但也就那三节
 *   圆签    给的是「一桌可选项」—— 六个平权的角度，挑三个答，自由但没方向
 *
 * 实现上刻意和 story.js 保持同一套骨架（stash / 打字不 setData / 合稿 / 返回），
 * 这样比较的是设计差异，不是实现差异。
 */
const app = getApp();
const cues = require('../../utils/cues.js');
const marks = require('../../utils/marks.js');
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');

Page({
  data: {
    step: 'tags',            // tags | ask | draft
    eyebrow: '故 事',
    theme: '', mode: '',
    writing: false,

    tags: [], answered: 0, countHint: '',
    cur: null, rest: [],     // 正在答的那个签、底下可直接跳的那几个
    title: '', eg: '', answer: '', ph: '几个词就够',
    hits: [],

    // 合稿页：问答成对，逐条可改。editing 记的是正在改哪一条（'' = 没有，'extra' = 自由补充框）
    rows: [], undone: 0, extra: '', editing: '',
    storyText: '', tally: 0,
  },

  /**
   * @param {object} q 页面参数。
   *
   * 正常流程里场合是从定歌页经 globalData.draft 传下来的。
   * 但这一页还要能**被编译模式直接打开**（它不在正式流程上，只为对比），
   * 那时候 draft 是空的、场合是 '' —— 六个圆签全退回通用叫法，
   * 看起来就像"per-occasion 没生效"。
   * 所以额外认一个 ?occasion= 参数，编译模式里带上它就能直接看某个场合。
   */
  onLoad(q) {
    nav.apply(this);
    const d = app.globalData.draft || {};
    const fromQuery = q && q.occasion ? decodeURIComponent(q.occasion) : '';
    const oc = fromQuery || d.occasion || '';

    this._oc = oc;
    // 编译模式直接进来时 draft 里也没有收信人，给个名字，
    // 不然题面里的 {name} 全落成「ta」，看不出「小美，是个什么样的人」那种效果。
    this._name = (d.toName || (fromQuery ? '小美' : '')).trim();
    this._ans = {};
    this._qi = {};
    // 六个格子固定，叫法随场合变（见 cues.tags）
    this._tags = cues.tags(oc);
    this._tags.forEach((t) => { this._ans[t.k] = ''; this._qi[t.k] = 0; });
    this._cur = '';
    this._extra = '';
    this._touched = false;
    this._story = '';

    this.setData({ theme: theme.slug(oc), oc });
    this.toTags();
  },

  onShow() { mode.sync(this); },

  /* ── 六个圆签 ──────────────────────────────────────── */

  /** 签的 k 就是牌的类型 —— 六个圈各自从本场合这一类的牌里取。 */
  cardOf(k) {
    const p = cues.pool(k, this._oc);
    return p[this._qi[k] % p.length];
  },

  tagList() {
    return this._tags.map((t) => ({
      k: t.k, label: t.label, short: t.short,
      done: !!(this._ans[t.k] || '').trim(),
    }));
  },

  /**
   * 答了几个之后那一行小字。
   *
   * **一个都没答时什么都不说** —— 「已答 0 / 3」是这一页压力的全部来源，
   * 人还没动手就被告知欠了三笔。
   * 答过之后给的是理由（"会更像 ta"）不是指标（"还差两个"）：
   * 人为了让歌更像那个人会继续，为了填满进度条不会。
   */
  hintFor(n) {
    if (n <= 0) return '';
    if (n === 1) return '答了一个，再来一个会更像 ta';
    if (n === 2) return '答了两个，够写一首了';
    return `答了 ${n} 个，够写一首了`;
  },

  toTags() {
    const tags = this.tagList();
    const answered = tags.filter((x) => x.done).length;
    this.setData({
      step: 'tags', eyebrow: '故 事', writing: false,
      tags, answered, countHint: this.hintFor(answered),
    });
  },

  tapTag(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    this.stash();
    this._cur = k;
    this.toAsk();
  },

  /* ── 答一个 ────────────────────────────────────────── */

  toAsk() {
    const k = this._cur;
    const card = this.cardOf(k);
    const all = this.tagList();
    this.setData({
      step: 'ask',
      eyebrow: '故 事',
      writing: false,
      cur: all.find((x) => x.k === k),
      // 底下那排不含当前这个 —— 站在自己那一页上还摆着自己，是句废话。
      rest: all.filter((x) => x.k !== k),
      title: cues.fill(card.q, this._name),
      eg: card.eg || '',
      ph: '几个词就够',
      answer: this._ans[k],
      hits: marks.pick(this._ans[k]),
    });
  },

  /** 换个问法。已经写下的字留着，不清空。 */
  swapQ() {
    this.stash();
    this._qi[this._cur] += 1;        // cardOf 里取模，不会越界
    this.toAsk();
  },

  /** 存下这句 → 回到那六个圆签。 */
  saveAsk() {
    this.stash();
    this.toTags();
  },

  /**
   * 接着答下一个：跳到**还没答**的那一个。
   * 全答完了就回签页 —— 那时候该做的是点「下一步」，不是再转一圈。
   */
  nextUndone() {
    this.stash();
    const order = this._tags.map((t) => t.k);
    const from = order.indexOf(this._cur);
    for (let i = 1; i <= order.length; i++) {
      const k = order[(from + i) % order.length];
      if (!(this._ans[k] || '').trim()) { this._cur = k; return this.toAsk(); }
    }
    this.toTags();
  },

  startWriting() { this.setData({ writing: true }); },

  onInput(e) { this._live = e.detail.value; },

  stopWriting(e) {
    const v = (e && e.detail && e.detail.value !== undefined) ? e.detail.value : (this._live || '');
    this._live = v;
    this.stash();
    // 合稿页改完某一条，整页重算 —— 答案变了，拼出来的正文和「记下了」都得跟着变。
    if (this.data.step === 'draft') return this.toDraft(false);
    this.setData({ writing: false, answer: v, hits: marks.pick(v) });
  },

  stash() {
    const v = this._live;
    if (v === undefined || v === null) return;
    // 合稿页上编辑的是**某一条答案**（或者那个自由补充框），不再是一整段正文。
    if (this.data.step === 'draft') {
      const k = this.data.editing;
      if (k === 'extra') this._extra = v;
      else if (k) this._ans[k] = v;
    } else if (this._cur) {
      this._ans[this._cur] = v;
    }
    this._live = undefined;
  },

  /* ── 合稿 ──────────────────────────────────────────── */

  /**
   * 拼给后端的那一段。**问题要跟着答案一起送。**
   *
   * 原来只送答案，于是 lyrics.js 拿到的是「长发飘扬」这样的碎片 ——
   * 没有上下文，模型只能瞎猜那是谁的头发、什么时候的事。
   * 一行问题一行答案，成本是几十个字，换来的是模型真看得懂。
   *
   * 问题单独占一行、不加「问：」这类前缀：它读起来就是一句自然的话，
   * 不会被当成格式标记。
   */
  assemble() {
    const qa = this._tags
      .filter((t) => (this._ans[t.k] || '').trim())
      .map((t) => `${cues.fill(this.cardOf(t.k).q, this._name).replace(/\n/g, '')}\n${this._ans[t.k].trim()}`);
    const extra = (this._extra || '').trim();
    if (extra) qa.push(extra);
    return qa.join('\n\n');
  },

  toDraft(blank) {
    this.stash();
    if (blank) { this._ans = {}; this._extra = ''; }

    // 只列答过的。没答的那几个用底下一行小字给最后一次机会，
    // 摆成空行只会让这一页看着像没做完的作业。
    const rows = this._tags
      .filter((t) => (this._ans[t.k] || '').trim())
      .map((t) => ({
        k: t.k,
        label: t.label,
        q: cues.fill(this.cardOf(t.k).q, this._name).replace(/\n/g, ''),
        a: this._ans[t.k].trim(),
      }));

    const text = this.assemble();
    this._story = text;
    this.setData({
      step: 'draft', eyebrow: '故 事 · 合 稿', writing: false, editing: '',
      rows,
      undone: this._tags.length - rows.length,
      extra: this._extra || '',
      storyText: text,
      tally: marks.count(text),
    });
  },

  /** 点某一条（或者「还想说点别的」）进编辑。一次只开一个。 */
  editRow(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    this.setData({ editing: k });
  },

  toDone() {
    if (!this.data.answered) {
      return wx.showToast({ title: '至少答一个', icon: 'none' });
    }
    this.toDraft(false);
  },
  toFree() { this.toDraft(true); },


  /* ── 出页 ──────────────────────────────────────────── */

  next() {
    this.stash();
    const story = (this._story || '').trim();
    if (!story) return wx.showToast({ title: '先说说这个人/事', icon: 'none' });
    if (this._going) return;
    this._going = true;

    app.globalData.draft = {
      ...(app.globalData.draft || {}),
      story,
      answers: { ...this._ans },
    };
    wx.navigateTo({
      url: '/pages/tune/tune',
      fail: (e) => {
        this._going = false;
        console.error('navigateTo tune failed:', e);
        wx.showModal({ title: '打不开定调页', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },

  /** 签页是枢纽：答题页和合稿页都退回签页。 */
  back() {
    this.stash();
    if (this.data.step === 'tags') {
      return wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/order/order' }) });
    }
    this.toTags();
  },
});
