/**
 * 场合名 → 主题 slug。
 *
 * 页面根 view 上的 class 是 `t-{{theme}}`，theme 必须是 ASCII：
 * WXSS 的选择器解析器吃不下中文类名，`.t-求婚 {}` 会让整个 app.wxss
 * 编译失败 —— 而 app.wxss 一挂，所有页面都是白屏。
 * 所以中文只留在 UI 文案和发给后端的数据里，样式表里一个中文都不出现。
 */
const SLUG = {
  婚礼: 'wedding',
  告白: 'confess',
  给亲人: 'family',
  给孩子: 'kid',
  生日: 'birthday',
  感恩: 'thanks',
  道歉: 'apology',
  送别: 'farewell',
  想念: 'missing',
  纪念日: 'anniv',
  分手: 'breakup',
  鼓舞: 'cheer',
  一段日子: 'days',
  倾诉: 'vent',
};

module.exports = { slug: (occasion) => SLUG[occasion] || '' };
