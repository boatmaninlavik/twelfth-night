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
import { createOrder, getOrder, listOrders, updateOrder, putAudio } from './store.js';
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
 * original first tells the user their own voice was pasted on afterwards. The only
 * audio this API hands out is `result_url`.
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
  createdAt: o.created_at,
  resultUrl: o.result_url,
  error: o.error,
});

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

app.get('/api/search', wrap(async (req, res) => {
  res.json({ songs: await searchSongs(String(req.query.q || '')) });
}));

/** Create an order and start the pipeline. Returns immediately with an id to poll. */
app.post('/api/orders', wrap(async (req, res) => {
  const { story, occasion, toName, fromName, refSong, openid } = req.body || {};
  if (!story?.trim()) return res.status(400).json({ error: '请先讲讲这个人' });

  const order = await createOrder({
    story: story.trim(),
    occasion: occasion || null,
    to_name: toName || null,
    from_name: fromName || null,
    ref_song: refSong || null,
    openid: openid || null,
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

  // 录音和分轨谁后到谁启动第二波。这里是「录音后到」的那一半；
  // 另一半在 pipeline.js 分轨完成处。
  if (updated.vocal_url && updated.instrumental_url) {
    runVoiceSwap(updated).catch((e) => console.error('swap crashed:', e));
  }

  res.json({ ok: true, path, bytes: req.file.size });
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`十二夜 API listening on http://0.0.0.0:${port}`);
  console.log(`  健康检查  http://localhost:${port}/api/health`);
});
