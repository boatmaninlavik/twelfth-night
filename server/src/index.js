/**
 * 十二夜 API — internal testing build.
 *
 * Runs over plain HTTP on a LAN or server IP. That is fine for now: the WeChat
 * developer tools' "不校验合法域名" setting, plus the debug toggle inside the app on a
 * real phone, lets the mini program reach it without a filed domain or a certificate.
 * Both must be swapped for HTTPS on a filed domain before anything ships.
 */
import express from 'express';
import multer from 'multer';
import { credits } from './kie.js';
import { searchSongs } from './search.js';
import { createOrder, getOrder, listOrders, updateOrder, putAudio, db, BUCKET,
         getVoiceProfile, putVoiceProfile, dropVoiceProfile } from './store.js';
import { runPipeline, runVoiceSwap } from './pipeline.js';
import { openidFromCode } from './wx.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

/**
 * 自带字体。
 *
 * 界面用的是宋体，但 macOS 的宋体和 iOS 的宋体不是同一份文件，渲染也不一样 ——
 * 开发者工具里排得好好的一屏，到 iPhone 上字形和字重就变了。唯一能做到两边
 * 一模一样的办法是自己带字体。
 *
 * 思源宋体（SIL OFL，可自由嵌入分发），子集化到界面上写死的那 809 个字符，
 * 两个字重各 ~197 KB。带两个字重而不是让系统合成粗体 —— 合成算法各平台不同，
 * 那正是要消除的东西。
 *
 * 歌词和用户输入不在子集里：覆盖常用 3500 字要 1.2 MB，首次进入会明显卡一下，
 * 不值。那些退回系统衬线体。
 *
 * 缓存一年：字体内容不会变，变了就换文件名。
 */
app.use('/font', express.static(new URL('../assets', import.meta.url).pathname, {
  maxAge: '365d',
  immutable: true,
  setHeaders: (res) => res.set('Access-Control-Allow-Origin', '*'),
}));

// Recordings arrive in memory: the enrolment take is ~20 s, and buffering avoids a
// temp file that would then have to be cleaned up on every failure path.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(`${req.method} ${req.path}:`, e);
  res.status(500).json({ error: String(e.message || e) });
});

/**
 * The public shape of an order. Never hand the client the whole row — it carries the
 * kie.ai task id and the raw stem URLs.
 *
 * `song_url` (the Suno original) is left out on purpose, not merely unused: letting a
 * client see it makes it one line of code away from being played, and hearing the
 * original first tells the user their own voice was pasted on afterwards.
 *
 * 唯一的例外是**用户拒绝了声音授权**的那些单：那种单没有换声这一步，原版就是
 * 成品，不交付它就等于这一单永远做不完。授权弹窗里写着「你仍然可以下单，
 * 我们会用歌手的音色把这首歌做完」—— 写了就得真做到。
 */
const publicOrder = (o) => ({
  id: o.id,
  status: o.status,
  title: o.title,
  lyrics: o.lyrics,
  lyricLines: o.lyric_lines || null,
  toName: o.to_name,
  fromName: o.from_name,
  occasion: o.occasion,
  // 分享卡片上要写「灵感来自 周杰伦《晴天》」，所以这一项得交出去。
  // 不是敏感信息：歌名和歌手名是公开事实，而且正是要给收信人看的那一句。
  refSong: o.ref_song || null,
  createdAt: o.created_at,
  resultUrl: o.use_own_voice === false ? (o.result_url || o.song_url) : o.result_url,
  usedOwnVoice: o.use_own_voice !== false,
  error: o.error,
});

/**
 * 声音档案的公开形状。**绝不交出 voice_path** —— 那是 bucket 里那份录音的
 * 位置，客户端拿到它就离"能下载别人的声音"只差一步。
 * 客户端只需要知道"有没有、什么时候录的、还剩多久"。
 */
const publicVoice = (v) => (v ? {
  createdAt: v.created_at,
  expiresAt: v.expires_at,
  durationSec: v.duration_sec,
  audioMd5: v.audio_md5,
} : null);

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ ok: true, credits: await credits().catch(() => null) });
}));

// wx.login 的 code 换 openid。发「歌做好了」的订阅消息要用它。
// 小程序端在 onLaunch 拿 code，这里换完存进 globalData，下单时带上。
app.post('/api/session', wrap(async (req, res) => {
  const code = req.body?.code;
  if (!code) return res.status(400).json({ error: '缺 code' });
  try {
    res.json({ openid: await openidFromCode(code) });
  } catch (e) {
    // 拿不到 openid 只是收不到通知，不该挡住做歌
    console.warn('[wx] code2Session 失败:', e.message);
    res.json({ openid: null });
  }
}));

/**
 * 自检。确认这台机器（很可能是 Modal 容器）能不能真的把活派出去。
 *
 * 换音和歌词对齐是**起 Python 子进程调 Modal**完成的，而那条路只有在真的
 * 下一单时才会走到。没有这个接口的话，"能不能出歌"要等一首歌做废了才知道。
 */
app.get('/api/selftest', wrap(async (_req, res) => {
  const { spawn } = await import('node:child_process');
  const run = (args) => new Promise((resolve) => {
    const c = spawn('python3', args);
    let out = '', err = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { err += b; });
    c.on('error', (e) => resolve({ ok: false, msg: e.message }));
    c.on('close', (code) => resolve({ ok: code === 0, msg: (out + err).trim().slice(-300) }));
  });
  res.json({
    python: await run(['-c', 'import sys; print(sys.version.split()[0])']),
    modalSdk: await run(['-c', 'import modal; print(modal.__version__)']),
    // 能查到函数就说明凭据和 workspace 都对；不真的调用，不花钱。
    swapFn: await run(['-c',
      'import modal; f=modal.Function.from_name("twelfth-swap","swap"); print("ok")']),
    alignFn: await run(['-c',
      'import modal; f=modal.Function.from_name("twelfth-align","align"); print("ok")']),
  });
}));

/* ── 声音档案 ──────────────────────────────────────────
   录音挂在人身上不挂在单上。第二次下单的人不必重录、不必再走第一层授权，
   但**每一单仍然要签授权书** —— 那份文件是按单留证的。 */

/** 有没有一份还能用的档案。没有就返回 null，客户端据此决定是不是要录。 */
app.get('/api/voice', wrap(async (req, res) => {
  const openid = req.query.openid ? String(req.query.openid) : null;
  const token = req.query.token ? String(req.query.token) : null;
  if (!openid && !token) return res.json({ voice: null });
  res.json({ voice: publicVoice(await getVoiceProfile({ openid, token })) });
}));

/**
 * 撤回：删掉档案和它在 bucket 里的文件。
 *
 * 「随时可以撤回」写在授权书第三条里，这条路就必须真的能跑通 ——
 * 监管检查和用户投诉时第一个被验证的就是它。
 * 不动订单：授权书 3.4 说撤回不影响撤回前已完成的交付，做好的歌还是用户的。
 */
app.delete('/api/voice', wrap(async (req, res) => {
  const openid = req.query.openid ? String(req.query.openid) : null;
  const token = req.query.token ? String(req.query.token) : null;
  if (!openid && !token) return res.status(400).json({ error: '缺 openid 或 token' });

  const row = await getVoiceProfile({ openid, token });
  if (!row) return res.json({ ok: true });      // 本来就没有，也算删成功
  await dropVoiceProfile(row);
  res.json({ ok: true });
}));

app.get('/api/search', wrap(async (req, res) => {
  res.json({ songs: await searchSongs(String(req.query.q || '')) });
}));

/** Create an order and start the pipeline. Returns immediately with an id to poll. */
app.post('/api/orders', wrap(async (req, res) => {
  const { story, occasion, toName, fromName, refSong, openid,
          useOwnVoice, reuseVoice, deviceToken, consent, tune } = req.body || {};
  if (!story?.trim()) return res.status(400).json({ error: '请先讲讲这个人' });

  // 用旧档案的单：录音不再上传，这里直接从档案里取那份 voice_path。
  // 取不到就退回"等录音"的老路 —— 档案可能刚过期、刚被撤回，
  // 而那种情况下把整单打回去是最差的处理：用户什么也没做错。
  let voicePath = null;
  if (useOwnVoice !== false && reuseVoice) {
    const p = await getVoiceProfile({ openid: openid || null, token: deviceToken || null });
    voicePath = p?.voice_path || null;
  }

  const order = await createOrder({
    story: story.trim(),
    occasion: occasion || null,
    to_name: toName || null,
    from_name: fromName || null,
    ref_song: refSong || null,
    // 定调页挑的那张声音卡。sound 是给写歌模型的英文约束，用户看不见它。
    tune: tune || null,
    openid: openid || null,
    // 缺省为 true 是为了兼容老版本小程序：它们不发这个字段，而它们的行为
    // 就是"要用自己的声音"。默认成 false 会让老客户端的单全部退化成原版。
    use_own_voice: useOwnVoice !== false,
    // 档案里有就直接挂上，这一单不必再等上传。pipeline 分轨完成时会看这一列，
    // 看到了就直接启动换声（那段「谁最后到谁负责启动第二波」的逻辑不用改）。
    voice_path: voicePath,
    // 存证原样落库。**永远不要在这儿做"清洗"或"归一化"** ——
    // 存证的价值在于它是当时那一份，改过的存证等于没有存证。
    consent: Array.isArray(consent) && consent.length ? consent : null,
    status: 'created',
  });

  // Fire and forget: the client polls GET /api/orders/:id for progress.
  runPipeline(order).catch((e) => console.error('pipeline crashed:', e));
  res.json({ id: order.id, status: order.status });
}));

/**
 * 「我的」 list. `?ids=a,b,c` (the device's own index) and/or `?openid=`.
 *
 * Declared before `/api/orders/:id` only for readability — Express matches on the path,
 * and `/api/orders` never matches the `:id` route, so the order is not load-bearing.
 * The lyric payload is dropped here: word-level timestamps run to tens of KB per song
 * and a list of thirty of them would be megabytes for something the list never draws.
 */
app.get('/api/orders', wrap(async (req, res) => {
  // Filter to well-formed uuids. Postgres rejects the whole `in (…)` clause on one
  // malformed value, so a single stale entry in a device's local index would 500 the
  // request and freeze every other row on that user's list at its last-known state.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = String(req.query.ids || '').split(',')
    .map((s) => s.trim()).filter((s) => UUID.test(s));
  const openid = req.query.openid ? String(req.query.openid) : null;
  if (!ids.length && !openid) return res.json({ orders: [] });
  const rows = await listOrders({ ids, openid });
  res.json({
    orders: rows.map((o) => {
      const { lyrics, lyricLines, ...rest } = publicOrder(o);
      return rest;
    }),
  });
}));

app.get('/api/orders/:id', wrap(async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json(publicOrder(order));
}));

/**
 * The enrolment recording: ~20 s of do-re-mi across the user's range.
 *
 * Stored, then checked for the two things that actually ruin a take — too quiet
 * (phone held too far away) and clipped (held too close). Both are cheap to measure
 * and cheap to fix by asking for another take, which is far better than discovering it
 * after the GPU has run.
 */
app.post('/api/orders/:id/voice', upload.single('file'), wrap(async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const ext = (req.file.originalname?.split('.').pop() || 'mp3').toLowerCase();
  const path = `voice/${order.id}.${ext}`;
  await putAudio(path, req.file.buffer, req.file.mimetype || 'audio/mpeg');
  const updated = await updateOrder(order.id, {
    voice_path: path,
    updated_at: new Date().toISOString(),
  });

  /**
   * 顺手建档（或者换掉旧档）。
   *
   * 放在这儿而不是单独开一个上传接口：录音只有这一条路进得来，
   * 在这一条路上建档，就不会出现"传了但没建档"的中间态。
   *
   * 建档失败不回滚这一单 —— 录音已经挂在订单上了，这首歌照做。
   * 代价只是下次要重录一遍，那比让用户看见"提交失败"好得多。
   */
  let profile = null;
  try {
    profile = await putVoiceProfile({
      openid: order.openid || null,
      token: req.body?.deviceToken || null,
      voicePath: path,
      durationSec: Number(req.body?.durationSec) || null,
      audioMd5: req.body?.audioMd5 || null,
      consent: order.consent || null,
    });
  } catch (e) {
    console.warn(`order ${order.id} 建声音档案失败（不影响本单）:`, e.message);
  }

  // 录音和分轨谁后到谁启动第二波。这里是「录音后到」的那一半；
  // 另一半在 pipeline.js 分轨完成处。
  if (updated.vocal_url && updated.instrumental_url) {
    runVoiceSwap(updated).catch((e) => console.error('swap crashed:', e));
  }

  res.json({ ok: true, path, bytes: req.file.size, voice: publicVoice(profile) });
}));

/**
 * 撤回授权：删掉这一单的录音。
 *
 * 「授权人有权随时撤回」写在授权书第三条里，那这条路就必须真的能跑通。
 * 监管检查和用户投诉时第一个被验证的就是它 ——「你说能删，现在删一个我看看」。
 *
 * 删的是**录音本体**，不是订单：已经交付的成品归用户所有，撤回不影响
 * 撤回前已完成的交付（授权书 3.4）。同时把 use_own_voice 翻成 false，
 * 否则换声那一步还会去 bucket 里找一个已经不存在的文件。
 *
 * consent 那一列不删：它记的是"用户当时同意过"这件事本身，不含声纹数据，
 * 删掉反而失去了证明我们履行过义务的依据。撤回动作自己也追加一条。
 */
app.delete('/api/orders/:id/voice', wrap(async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });

  if (order.voice_path) {
    const { error } = await db.storage.from(BUCKET).remove([order.voice_path]);
    // 文件已经不在了也算删成功 —— 用户要的结果已经达成，报错只会让他再点一次
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`删除录音失败: ${error.message}`);
    }
  }

  const trail = Array.isArray(order.consent) ? order.consent.slice() : [];
  trail.push({ layer: 'revoke', revokedAt: new Date().toISOString() });

  await updateOrder(order.id, {
    voice_path: null,
    use_own_voice: false,
    consent: trail,
    updated_at: new Date().toISOString(),
  });

  res.json({ ok: true });
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`十二夜 API listening on http://0.0.0.0:${port}`);
  console.log(`  健康检查  http://localhost:${port}/api/health`);
});
