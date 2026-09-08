/**
 * 自绘导航栏的两个数：返回键放哪儿、正文从哪儿开始。
 *
 * navigationStyle 是 custom，系统既不画返回箭头也不给我们任何布局参考，
 * 于是返回键的位置一开始是拍的（top: 100rpx）。结果是它跟正文第一行
 * （「故事」「歌单」那行小标）挤在一起，看着像正文的一部分。
 *
 * 屏幕右上角那个「··· ⊙」胶囊是这一屏唯一的系统元件，而且**它的位置每台
 * 设备都不一样**（刘海、灵动岛、安卓各家）。所以对齐它 —— 返回键跟胶囊
 * 同一条水平线，正文从胶囊下沿再让开一段。这样在任何机型上都是对的，
 * 而且看着像系统排的，不像我们摆的。
 *
 * wx.getMenuButtonBoundingClientRect() 给的是 px，页面用的是 rpx，
 * 换算系数是 750 / 屏宽px —— 不换算的话在非 375pt 宽的机器上会整体偏。
 */
const GAP = 44;              // 胶囊下沿到正文第一行的留白（rpx）

let cached = null;

function bar() {
  if (cached) return cached;
  try {
    const r = wx.getMenuButtonBoundingClientRect();
    const w = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth;
    if (!r || !r.height || !w) throw new Error('no rect');
    const k = 750 / w;
    const top = r.top * k;
    const size = r.height * k;
    cached = { navTop: Math.round(top), navSize: Math.round(size),
               padTop: Math.round(top + size + GAP) };
  } catch (e) {
    // 取不到就退回一组保守的常数：比原来那个 100/132 松，够避开刘海。
    cached = { navTop: 96, navSize: 64, padTop: 204 };
  }
  return cached;
}

/** 页面 onLoad 里调一次：把三个数塞进 data，模板用行内样式取。 */
function apply(page) {
  page.setData(bar());
}

module.exports = { bar, apply };
