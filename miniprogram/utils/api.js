/**
 * 后端地址。
 *
 * 指向已备案的自有域名。备案是硬条件：微信要求 request 合法域名必须已 ICP 备案，
 * 而上一版用的 erised2--twelfth-api-api.modal.run 是境外域名，备不了案 ——
 * 开发者工具里的 urlCheck:false 只骗得过工具自己和开发版，
 * **体验版和正式版强制校验**，所以那个地址根本发不出体验版。
 *
 * 后台要配的是**三张表**，都填这同一个域名。少一张就是一个只在体验版复现的 bug：
 *   request       wx.request       —— 下面所有接口
 *   uploadFile    wx.uploadFile    —— 上传录音，漏了的话下单走到最后一步才失败
 *   downloadFile  wx.loadFontFace  —— app.js 的自带宋体，漏了整个界面退回系统字体
 *
 * 成品 mp3 不在这三张表里：那是 Supabase 签发的临时 URL，由 innerAudioContext
 * 播放，而音频播放不走合法域名校验 —— 不用配，也不受这一行影响。
 *
 * 本地调试后端时把 BASE 换成 http://<本机IP>:3100，并重新打开那两个开关。
 */
const BASE = 'https://api.listeningmirage.com';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE + path,
      method: options.method || 'GET',
      data: options.data,
      header: { 'Content-Type': 'application/json' },
      timeout: 30000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error((res.data && res.data.error) || `HTTP ${res.statusCode}`));
      },
      fail: (e) => reject(new Error(e.errMsg || '网络失败')),
    });
  });
}

module.exports = {
  BASE,
  session: (code) => request('/api/session', { method: 'POST', data: { code } }),
  searchSongs: (q) => request(`/api/search?q=${encodeURIComponent(q)}`),
  createOrder: (data) => request('/api/orders', { method: 'POST', data }),
  getOrder: (id) => request(`/api/orders/${id}`),

  // 「我的」列表。id 来自本机记的那份索引（utils/library.js），openid 是补充：
  // 服务端认 openid，但它拿不稳，所以两个一起送，服务端有哪个用哪个。
  listOrders: (ids, openid) => {
    const q = [];
    if (ids && ids.length) q.push(`ids=${ids.map(encodeURIComponent).join(',')}`);
    if (openid) q.push(`openid=${encodeURIComponent(openid)}`);
    return request(`/api/orders?${q.join('&')}`);
  },

  uploadVoice: (id, filePath) =>
    new Promise((resolve, reject) => {
      wx.uploadFile({
        url: `${BASE}/api/orders/${id}/voice`,
        filePath,
        name: 'file',
        timeout: 60000,
        success: (res) => {
          try {
            const body = JSON.parse(res.data);
            if (body.error) reject(new Error(body.error));
            else resolve(body);
          } catch (e) {
            reject(new Error('上传返回无法解析'));
          }
        },
        fail: (e) => reject(new Error(e.errMsg || '上传失败')),
      });
    }),
};
