const app = getApp();
const theme = require('../../utils/theme.js');
const mode = require('../../utils/mode.js');
const nav = require('../../utils/nav.js');
const cues = require('../../utils/cues.js');
const marks = require('../../utils/marks.js');

/**
 * 定歌，第二步：故事。
 *
 * 原来这一页是一个 800 字的空框，提示语「不用写得漂亮，真诚就好」。
 * 那句话解的是「写得丑怎么办」，可绝大多数人卡住的是「不知道写什么」。
 * 而 server/src/lyrics.js 要的是**具体的物、时间、动作** —— 用户写
 * 「她很温柔，我很爱她」，模型只能还回被自己禁掉的那种词。
 *
 * 所以改成一问一答：发四张提词卡 → 挑一张答 → ta 是谁 → 一个细节 → 合稿。
 * 卡面和问法在 utils/cues.js，那是这一版真正的工作量。
 *
 * **五步全在这一个页面里走，不开新页。**
 * 小程序页面栈上限是 10，现在的路径已经是 扉页→定歌→故事→录音→作品 五层；
 * 故事再拆成五页就是九层，攒满之后 navigateTo 直接失败，而失败是没有任何
 * 提示的（order.js 和这个文件下面的 fail 回调就是为这个写的）。
 * 所以 step 是页内状态，返回键在页内退，退到头才真的出页。
 *
 * textarea 的处理照搬原来那一版，那不是洁癖是踩过的坑：它是原生组件，
 * 不在 WebView 里画，而是盖在上面的独立图层，层级压不住，页面一滚位置就可能
 * 同步不上，把下面的东西整片挡死（表现是"下一步点不动"）。
 * 所以只在真正打字的那一刻才挂它。
 *
 * 与原版的一处不同：这里**绑了 value**。原来不绑是因为绑上去等于每敲一个字
 * 整段文字跨一次线程再重渲一次；但那个代价只在 value 会随打字变化时才付。
 * 这里 answer 只在失焦和换题时才 setData，打字过程中一次都不动，
 * 所以绑上是安全的 —— 而且必须绑：退回上一问时框里得有上次写的字。
 */

/** 三节的槽位。次序即歌的次序（主歌一 / 主歌二 / 副歌），不要改。 */
const SLOTS = ['open', 'then', 'say'];

Page({
  data: {
    step: 'line',            // line | ask | draft
    eyebrow: '故 事',
    theme: '', mode: '',
    writing: false,

    // 一条线。nodes = [{k, label, hint, q, answer, done}]
    nodes: [], answered: 0,

    // 一问一答
    title: '', gloss: '', egs: [], answer: '', ph: '几个词就够',
    hits: [],                // 「记下了」挑出来的词，不足两个就是空数组

    // 合稿。canRestack 是数据、restack 是方法，故意不同名 —— 两个命名空间不冲突，
    // 但同名的话读代码的人得停下来想一秒。
    storyText: '', tally: 0, canRestack: false,
  },

  onLoad() {
    nav.apply(this);
    const d = app.globalData.draft || {};
    const oc = d.occasion || '';

    this._oc = oc;
    this._name = (d.toName || '').trim();
    this._deck = cues.deck(oc);      // 已洗好的一整副，只喂「后来」那一节
    this._ans = { open: '', then: '', say: '' };
    this._extras = [];               // 「再问我一个」答的，[{q, text}]
    this._slot = 'open';             // 正在答哪一节；'extra' 是追加题
    this._qi = { open: 0, then: 0, say: 0 };  // 各节的题面游标（换个问法）
    this._touched = false;           // 合稿是否被手改过

    this.setData({ theme: theme.slug(oc) });

    // 从录音页退回来时页面实例还在，什么都不用做。
    // 但 reLaunch 回来（或者以前那一版留下的草稿）只剩一段 story，
    // 这时直接落在合稿页，别让人重答一遍。
    if (d.story && d.story.trim()) {
      this._story = d.story;
      this._touched = true;
      return this.toDraft(false);
    }
    this.toLine();
  },

  onShow() { mode.sync(this); },

  /* ── 一条线 ────────────────────────────────────────── */

  /**
   * 某一节当前的题面卡。
   *
   * 走 cues.pool(类型, 场合) —— 和圆签那一版同一个入口。
   *
   * 原来这里是写死的：「开头」和「想说的话」直接取通用题池、**完全不看场合**，
   * 「后来」则从整副场合牌里随便抓、**不管类型**。
   * 后果是生日那一单的三节里两节是通用题，第三节还抓到了一张「那个地方」类的牌
   * （「上次给 ta 过生日是在哪儿」挂在了「后来」下面）。
   * 给 104 张牌打类型标之后忘了把这一版也接过来，是我漏的。
   */
  cardOf(slot) {
    const p = cues.pool(slot, this._oc);
    return p[this._qi[slot] % p.length];
  },

  /**
   * 画那条线。
   *
   * 三个节点一屏看全，答过的点实心、没答的空心 ——
   * 这就是进度，不必再另做一根进度条（这册书里本来也没有进度条）。
   */
  toLine() {
    const nodes = cues.LINE.map((n) => {
      const a = (this._ans[n.k] || '').trim();
      return {
        k: n.k, label: n.label, hint: n.hint,
        // 题面里的 {br} 是给答题页排两行用的；线上这儿是一行，
        // 直接接起来 —— 换成空格会在逗号后面多出一格。
        q: cues.fill(this.cardOf(n.k).q, this._name).replace(/\n/g, ''),
        answer: a,
        done: !!a,
      };
    });
    this.setData({
      step: 'line', eyebrow: '故 事', writing: false,
      nodes, answered: nodes.filter((x) => x.done).length,
    });
  },

  openSlot(e) {
    const k = e.currentTarget.dataset.k;
    if (!k) return;
    this._slot = k;
    this.toAsk();
  },

  /** 三节一个都不想答 —— 直接去合稿页自己写，这条路一直留着。 */
  toFree() {
    this.toDraft(true);
  },

  /* ── 一问一答 ──────────────────────────────────────── */

  /** 按 _slot 把题面、提示和已有的答案摆好。 */
  toAsk() {
    const s = this._slot;
    let title, gloss = '', egs = [], answer, eyebrow;

    /* 卡面小字挪进输入框当占位符，不再单占一行顶在框上面。
       放进框里：人正要动手的地方就摆着提示，打第一个字它就消失，不占版面。

       **用「·」连，不用「比如」。**
       103 张卡里有一半的小字根本不是示例答，是指导语 ——
       「不用写得像誓词」「原话就行」「越没用越好」这些，前面加「比如」就成了病句。
       而逐条去分类也不成立：「头发、脾气，还是口味」两边都像。
       「·」不声称两者是什么关系，示例和指导语都挂得住。

       第二、三问的 gloss 是指导语（「越小越好」那种），要一直看得见，
       所以那两问的小字保持原样，示例仍由「别人这么答」那一块负责。 */
    const box = (eg) => (eg ? `几个词就够 · ${eg}` : '几个词就够');
    let ph = '几个词就够';

    if (s === 'extra') {
      title = cues.fill(this._extraQ.q, this._name);
      ph = box(this._extraQ.eg);
      answer = '';
      eyebrow = '故 事 · 再 一 问';
    } else {
      const card = this.cardOf(s);
      const node = cues.LINE.find((x) => x.k === s);
      title = cues.fill(card.q, this._name);
      gloss = node.hint;                 // 「一个能看见的画面」——说的是这一节要什么
      ph = box(card.eg);
      answer = this._ans[s];
      eyebrow = `故 事 · ${node.label}`;
    }

    this.setData({
      step: 'ask', eyebrow, title, gloss, egs, answer, ph,
      writing: false,
      hits: marks.pick(answer),
    });
  },

  /**
   * 换个问法。
   *
   * 这一处比「跳过」重要得多：答不上来往往不是没话说，是**这个问法**不对。
   * 第一问换的是牌（往后发一张），后两问换的是同一件事的另一个角度。
   * 已经写下的字留着，不清空。
   */
  swapQ() {
    // 换题前先把正在写的字收进槽位，否则换完就没了
    this.stash();
    if (this._slot === 'extra') this._extraQ = this.nextExtra();
    else this._qi[this._slot] += 1;      // cardOf 里取模，不会越界
    this.toAsk();
  },

  /**
   * 「再问我一个」的追加题：顺着场合牌堆往后拿一张。
   * 跳过刚问过的那一张 —— 换出同一句来，看着就像功能坏了。
   */
  nextExtra() {
    const d = this._deck;
    const seen = new Set(this._extras.map((x) => x.q));
    if (this._extraQ) seen.add(this._extraQ.q);
    return d.find((c) => !seen.has(c.q)) || d[0];
  },

  startWriting() { this.setData({ writing: true }); },

  // 打字过程中只写 this._live，不 setData：
  // 绑上去等于每敲一个字整段文字跨一次线程再重渲一次。
  onInput(e) { this._live = e.detail.value; },

  /**
   * 失焦即卸载 textarea —— 页面上不留原生图层，下面的按钮才点得动。
   * 「记下了」也在这一刻算：打字过程中算等于每个字算一遍，
   * 而且一行字在眼皮底下跳来跳去比没有反馈更烦人。
   */
  stopWriting(e) {
    const v = (e && e.detail && e.detail.value !== undefined) ? e.detail.value : (this._live || '');
    this._live = v;
    this.stash();
    if (this.data.step === 'draft') {
      this._touched = true;
      this._story = v;
      this.setData({ writing: false, storyText: v, tally: marks.count(v) });
    } else {
      this.setData({ writing: false, answer: v, hits: marks.pick(v) });
    }
  },

  /** 把 textarea 里的实时值收进它该去的槽位。 */
  stash() {
    const v = this._live;
    if (v === undefined || v === null) return;
    if (this.data.step === 'draft') { this._story = v; this._touched = true; }
    else if (this._slot === 'extra') this._extraText = v;
    else this._ans[this._slot] = v;
    this._live = undefined;
  },

  /**
   * 答完一节，回到那条线上。
   *
   * 不再是"下一问"——三节不按顺序强推，用户想先答哪节就先答哪节。
   * 答不上来照走：「跳过」和「记下」走的是同一条路。
   */
  doneAsk() {
    this.stash();
    if (this._slot === 'extra') {
      const t = (this._extraText || '').trim();
      if (t) this._extras.push({ q: this._extraQ.q, text: t });
      this._extraText = '';
      return this.toDraft(false, t);
    }
    this.toLine();
  },

  /** 三节都答过了（或者用户点了「写好了」），去合稿。 */
  toDone() {
    this.stash();
    this.toDraft(false);
  },

  /* ── 合稿 ──────────────────────────────────────────── */

  /**
   * 把三段答案拼成一段。
   *
   * 拼的次序和问的次序**不一样**：问的时候先答他挑中的那张卡（那是他有话说的
   * 地方，得先给他一个顺手的开头），拼的时候把「ta 是谁」提到最前 ——
   * 人物、事件、细节，这是写词的人拿到手最好读的次序。
   *
   * 不加「他是谁：」这类小标：这段文字是要给用户直接改的，
   * 标签留在里头，改起来碍事，而且它会跟着进 lyrics.js 的 prompt 被当成正文。
   */
  assemble() {
    const a = this._ans;
    // 拼的次序就是问的次序 —— 开头、后来、想说的话，本来就是歌的次序。
    // （老版本要把「ta 是谁」提到最前，因为那是人物介绍；现在没有那一节了。）
    const parts = [a.open, a.then, a.say, ...this._extras.map((x) => x.text)];
    return parts.map((s) => (s || '').trim()).filter(Boolean).join('\n\n');
  },

  /**
   * @param {boolean} blank 直接空着进来（「都不是，我自己写」）
   * @param {string}  add   「再问我一个」刚答完的那段，追加到末尾
   */
  toDraft(blank, add) {
    let text;
    if (add) {
      // 追加：不管改没改过，都接在现有文字后面 —— 这样「再问我一个」
      // 在任何情况下都是加一段，不会把人手改过的东西冲掉。
      text = [(this._story || '').trim(), add.trim()].filter(Boolean).join('\n\n');
      this._touched = true;
    } else if (blank) {
      text = '';
    } else if (this._touched) {
      text = this._story || '';       // 手改过就不重排，改用下面那个「按新答案重排」
    } else {
      text = this.assemble();
    }
    this._story = text;
    this.setData({
      step: 'draft', eyebrow: '故 事 · 合 稿', writing: false,
      storyText: text,
      tally: marks.count(text),
      // 手改过、而且重排出来跟现在不一样，才给这个入口
      canRestack: this._touched && this.assemble() !== text && !!this.assemble(),
    });
  },

  restack() {
    this._touched = false;
    this._story = this.assemble();
    this.setData({
      storyText: this._story, tally: marks.count(this._story), canRestack: false, writing: false,
    });
  },

  /** 再问我一个：从场合牌堆里拿一张没问过的。 */
  askMore() {
    this.stash();
    this._extraQ = this.nextExtra();
    this._slot = 'extra';
    this._extraText = '';
    this.toAsk();
  },

  /* ── 出页 ──────────────────────────────────────────── */

  next() {
    this.stash();
    const story = (this._story || '').trim();
    if (!story) return wx.showToast({ title: '先说说这个人/事', icon: 'none' });

    // 连点两下会压两个页进栈；页面栈上限是 10，
    // 攒满之后 navigateTo 直接失败 —— 而失败是没有任何提示的。
    if (this._going) return;
    this._going = true;

    app.globalData.draft = {
      ...(app.globalData.draft || {}),
      story,
      // 答案单独留一份：从录音页 reLaunch 回来时页面实例已经没了，
      // 有这个才能把人放回合稿页而不是让他重答一遍。
      answers: { ...this._ans, extras: this._extras.slice() },
    };
    // 故事之后先定调，再去录音。调子属于"这首歌是什么"这一组
    // （给谁 → 场合 → 参考歌 → 故事 → 调子），录音和授权是提交前的最后一关。
    wx.navigateTo({
      url: '/pages/tune/tune',
      // 必须有 fail：navigateTo 失败时什么都不会发生，界面上完全看不出来，
      // 表现就是"按钮点不动"。页面栈溢出、路径写错都会走到这儿。
      fail: (e) => {
        this._going = false;
        console.error('navigateTo tune failed:', e);
        wx.showModal({ title: '打不开定调页', content: String(e.errMsg || e), showCancel: false });
      },
      complete: () => { this._going = false; },
    });
  },

  /**
   * 返回键在页内退，退到头才真的出页。
   * 这是把五步塞进一个页面之后必须自己接管的那一半 —— 不接管的话，
   * 用户在第三问按返回，一下子被弹回定歌页，前面答的全没了。
   */
  back() {
    this.stash();
    const s = this.data.step;

    // 那条线是这一页的枢纽：答题页退回线上，合稿页也退回线上。
    if (s === 'draft') return this.toLine();

    if (s === 'ask') {
      if (this._slot === 'extra') return this.toDraft(false);
      return this.toLine();
    }

    wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/order/order' }) });
  },
});
