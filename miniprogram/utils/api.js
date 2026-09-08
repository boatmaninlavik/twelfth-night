/**
 * 后端地址。
 *
 * 现在指向 Modal 上托管的服务（app twelfth-api，workspace erised2），
 * **不再是这台开发机**。以前是局域网 IP + 明文 HTTP，意味着：
 *   · 开发者笔记本一合盖，用户在手机上就什么都做不了
 *   · 每换一次 Wi-Fi 都要来改这一行（这个坑踩过三次）
 *   · 真机必须开"调试"才连得上，体验版发不出去
 *
 * 换成 https 之后，只要把这个域名加进小程序后台的服务器域名白名单，
 * 就不再需要"不校验合法域名"那个开关，体验成员扫码就能用。
 *
 * 本地调试后端时把 BASE 换成 http://<本机IP>:3100，并重新打开那两个开关。
 */
const BASE = 'https://erised2--twelfth-api-api.modal.run';

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
