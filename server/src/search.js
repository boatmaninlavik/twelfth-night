/**
 * 参考歌曲搜索。
 *
 * 走 QQ 音乐的 **smartbox**（搜索框联想）而不是 client_search_cp：
 *
 *   · client_search_cp 已经返回 HTTP 500 + 空 body（所有查询都是），被挡了。
 *     旧代码在那种情况下静默退回 iTunes，而 iTunes 的中文库烂到不能用 ——
 *     搜「晴天」出来的是 田各田各、苏念一、Adia Chan，周杰伦一条都没有。
 *     静默降级是这里最坏的行为：接口没坏、结果全错，没人看得出来。
 *   · smartbox 的排序反而更好，因为它是"猜你要搜什么"，天然按知名度排：
 *     晴天→周杰伦、稻香→周杰伦、龙卷风→周杰伦、bohemian rhapsody→Queen，
 *     全部第一条命中。代价是它只给 4 条，且不带专辑信息。
 *
 * 封面要多一跳：smartbox 只给 songmid，用 fcg_play_single_song 换到 albummid
 * 才能拼出封面 URL。四条并发，一次搜索多花不到一秒。
 *
 * 兜底是 Deezer（跟 erised-web 一致）。它对中文一样不行 —— 搜「晴天」出来是
 * desert sand feels warm、SUGARCAT —— 所以兜底触发时**必须打日志喊出来**，
 * 那是"搜索坏了"的信号，不是一个可以接受的稳态。
 *
 * 这几个都是非官方端点，随时可能再变。正式商用前该换成有授权的接口。
 */
const SMARTBOX = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const SONG_INFO = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';
const QQ_HEADERS = { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' };

// 明显不是"某首歌的原版"的东西。smartbox 排序已经很干净，这里只做最后一道保险。
const JUNK = /(伴奏|纯音乐|卡拉\s*ok|karaoke|instrumental|铃声|翻唱|翻自|童声|dj\s*版|\d+(\.\d+)?x版|抖音|喜马拉雅|网络歌手)/i;

async function fetchJson(url, init = {}, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!text.trim()) throw new Error(`空响应 (HTTP ${res.status})`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * songmid → 专辑封面。拿不到就返回歌手图，最后才是 null。
 *
 * 带缓存：封面跟 songmid 是死绑定的，同一首歌查一次就够。
 * 用户搜「晴」「晴天」会连着打两三次，热门歌在结果里反复出现 ——
 * 不缓存的话每次都要往 QQ 跑一趟，而这一趟正是搜索里最慢的部分
 * （容器在美国，QQ 在国内，一个来回三四百毫秒）。
 */
const COVERS = new Map();
const COVER_MAX = 500;                 // 够内测用；满了就整个丢掉重来，不做 LRU

async function cover(songmid) {
  if (COVERS.has(songmid)) return COVERS.get(songmid);
  const v = await coverFetch(songmid);
  if (v.art) {                          // 只缓存成功的：失败多半是超时，下次该再试
    if (COVERS.size >= COVER_MAX) COVERS.clear();
    COVERS.set(songmid, v);
  }
  return v;
}

async function coverFetch(songmid) {
  try {
    const d = await fetchJson(
      `${SONG_INFO}?songmid=${encodeURIComponent(songmid)}&platform=yqq&format=json`,
      // 封面的超时要比主搜索短得多。Promise.all 等最慢的那一个 ——
      // 一条封面卡 6 秒，整次搜索就是 6 秒，而封面缺一张只是少一个缩略图。
      { headers: QQ_HEADERS }, 1200);
    const t = d?.data?.[0];
    const amid = t?.album?.mid;
    if (amid) {
      return {
        art: `https://y.qq.com/music/photo_new/T002R300x300M000${amid}.jpg`,
        album: t?.album?.name || '',
      };
    }
    const smid = t?.singer?.[0]?.mid;
    return { art: smid ? `https://y.qq.com/music/photo_new/T001R300x300M000${smid}.jpg` : null,
             album: '' };
  } catch {
    return { art: null, album: '' };
  }
}

async function qq(query) {
  const d = await fetchJson(
    `${SMARTBOX}?format=json&key=${encodeURIComponent(query)}&utf8=1`,
    { headers: QQ_HEADERS });
  const list = (d?.data?.song?.itemlist || [])
    .filter((t) => !JUNK.test(`${t.name} ${t.singer}`));
  if (!list.length) return [];

  // 并发查封面，而且只查要显示的前几条 —— smartbox 有时回十几条，
  // 多查出来的既不显示，还把整次搜索拖慢。
  const top = list.slice(0, 8);
  const arts = await Promise.all(top.map((t) => cover(t.mid)));
  list.length = top.length;
  return list
    .map((t, i) => ({
      id: String(t.mid || t.id),
      name: t.name || '未知歌曲',
      artist: t.singer || '未知歌手',
      album: arts[i].album,
      albumArt: arts[i].art,
    }))
    // 专辑名是查封面之后才有的，所以过滤要在这里再走一遍 ——
    // 「于潼的翻唱」「乃吉的翻唱集」这类破绽只写在专辑名上。
    .filter((t) => !JUNK.test(t.album));
}

async function deezer(query) {
  const d = await fetchJson(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=8`, {}, 5000);
  if (d.error) throw new Error(d.error.message || 'deezer error');
  return (d.data || [])
    .filter((t) => !JUNK.test(`${t.title} ${t.artist?.name || ''}`))
    .map((t) => ({
      id: String(t.id),
      name: t.title || '未知歌曲',
      artist: t.artist?.name || '未知歌手',
      album: t.album?.title || '',
      albumArt: t.album?.cover_medium || t.album?.cover || null,
    }));
}

export async function searchSongs(query) {
  if (!query?.trim()) return [];
  try {
    const hits = await qq(query);
    if (hits.length) return hits;
    console.warn(`[search] QQ 对「${query}」返回 0 条 —— 退回 Deezer，中文结果会很差`);
  } catch (e) {
    // 这条日志很重要：接口被挡时结果依然"有内容"，只有靠它才知道降级了
    console.error(`[search] QQ 挂了（${e.message}）—— 退回 Deezer，中文结果会很差`);
  }
  try {
    return await deezer(query);
  } catch (e) {
    console.error(`[search] Deezer 也挂了：${e.message}`);
    return [];
  }
}
