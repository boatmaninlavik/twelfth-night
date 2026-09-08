/**
 * One order, start to finish. Runs in-process — internal testing volume is one person
 * at a time, and a real queue can wait until that stops being true.
 *
 * Deliberately delivers in two waves:
 *   wave 1  the Suno song, playable as soon as it exists
 *   wave 2  the same song re-sung in the user's voice
 *
 * The user should not stare at a spinner while a GPU warms up, and wave 1 also means
 * the mini program is fully testable before the conversion stage is wired to Modal.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeLyrics } from './lyrics.js';
import { generate, songStatus, separateStems } from './kie.js';
import { updateOrder, getOrder, putAudio, db, BUCKET } from './store.js';
import { notifySongReady } from './wx.js';

const failed = (s) => /FAIL|ERROR/i.test(String(s || ''));

/** Poll Suno until a finished track exists. */
async function waitForSong(taskId, timeoutMs = 480_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    let d;
    try {
      d = await songStatus(taskId);
    } catch {
      continue;                       // transient; the deadline is the real limit
    }
    if (failed(d?.status)) throw new Error(`suno ${d.status}: ${d?.errorMessage || 'unknown'}`);
    const track = d?.response?.sunoData?.[0];
    if (d?.status === 'SUCCESS' && track?.audioUrl) return track.audioUrl;
  }
  throw new Error('timed out waiting for Suno');
}

export async function runPipeline(order) {
  const id = order.id;
  const set = (patch) => updateOrder(id, { ...patch, updated_at: new Date().toISOString() });

  try {
    await set({ status: 'writing' });
    const { title, lyrics, style } = await writeLyrics(order);
    await set({ status: 'generating', title, lyrics, style });

    const { taskId } = await generate({ lyrics, style, title });
    await set({ suno_task_id: taskId });

    const songUrl = await waitForSong(taskId);
    // Wave 1 is live from here: the mini program can play song_url already.
    await set({ status: 'generated', song_url: songUrl });

    // Separation is the 10-credit `separate_vocal` tier — two stems, no isolated
    // backing vocals. If harmonies end up sounding converted and wrong, this is the
    // line to move up to the 50-credit multi-stem tier (see kie.js).
    const stems = await separateStems(songUrl);
    if (!stems) {
      // Not fatal: the song exists and is deliverable. Only the swap is blocked.
      await set({ status: 'awaiting_voice', error: '分轨失败，只能交付原版' });
      return;
    }
    await set({
      status: 'awaiting_voice',
      vocal_url: stems.vocalUrl,
      instrumental_url: stems.instrumentalUrl,
    });

    // 录音可能比出歌先到（用户唱完就走了），也可能后到。谁最后到谁负责启动
    // 第二波 —— 这里是「分轨最后到」的那一半。
    const fresh = await getOrder(id);
    if (fresh?.voice_path) runVoiceSwap(fresh).catch((e) => console.error('swap:', e));
  } catch (e) {
    console.error(`order ${id} failed:`, e);
    await set({ status: 'failed', error: String(e.message || e).slice(0, 500) }).catch(() => {});
  }
}

/**
 * 第二波 —— 把主唱换成用户的声音。
 *
 * 真正的活全在 Modal 上（app twelfth-swap，workspace erised2）：换音 + 8 道精修
 * 都在容器里跑完，这台机器只负责调度和存取。
 *
 * 以前这一步跑在本机（erised-artist 的脚本 + 它的 venv），意味着开发者的笔记本
 * 一合盖，用户在手机上下的单就永远做不完 —— 一个要交付给别人的产品不能是这样。
 *
 * 用子进程调 Python 而不是让 Node 直接发 HTTP：Modal 的 SDK 是 Python 的，
 * 而给那个 app 加 HTTP 入口要多一层部署和鉴权，不值当。
 */
export async function runVoiceSwap(order) {
  const id = order.id;
  const set = (patch) => updateOrder(id, { ...patch, updated_at: new Date().toISOString() });

  if (!order.vocal_url || !order.instrumental_url) return;   // 分轨还没好
  if (!order.voice_path) return;                             // 录音还没到

  let work;
  try {
    await set({ status: 'converting' });

    work = await mkdtemp(path.join(tmpdir(), 'tn-'));
    const voiceLocal = path.join(work, 'user' + path.extname(order.voice_path));
    const outLocal = path.join(work, 'result.mp3');

    const { data, error } = await db.storage.from(BUCKET).download(order.voice_path);
    if (error) throw new Error(`下载用户录音失败: ${error.message}`);
    await writeFile(voiceLocal, Buffer.from(await data.arrayBuffer()));

    // 换音和 8 道精修都在 Modal 上跑（app twelfth-swap，workspace erised2）。
    // 以前这一步要本机的 erised-artist 脚本和它的 venv —— 那意味着开发者的
    // 笔记本一合盖，用户在手机上下的单就永远做不完。现在这台机器只负责调度。
    await runWorker([
      '--vocal', order.vocal_url,
      '--instrumental', order.instrumental_url,
      '--user-voice', voiceLocal,
      '--out', outLocal,
    ]);

    const url = await putAudio(`result/${id}.mp3`, await readFile(outLocal), 'audio/mpeg');
    await set({ status: 'done', result_url: url, error: null });   // 清掉上一次失败留下的信息
    console.log(`order ${id} 换音完成`);

    // 第三波：歌词对齐。不 await —— 歌已经能听了，面板晚一分钟到没人察觉。
    // 失败也不影响交付：作品页会退回纯歌词。
    alignLyrics(id, url, order.lyrics).catch((e) => console.error(`align ${id}:`, e.message));

    // 通知用户。同样不 await，失败不影响交付。
    notifySongReady(order.openid, { title: order.title, toName: order.to_name })
      .then((r) => console.log(`order ${id} 通知:`, JSON.stringify(r)))
      .catch((e) => console.warn(`order ${id} 通知失败:`, e.message));
  } catch (e) {
    console.error(`order ${id} 换音失败:`, e);
    // 换音失败不等于这一单废了 —— 原版歌还在，用户仍然拿得到东西。
    await set({ status: 'done', error: `换音失败：${String(e.message || e).slice(0, 300)}` })
      .catch(() => {});
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function encodeMp3(src, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, '-codec:a', 'libmp3lame',
                                   '-b:a', '256k', dest]);
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(dest) : reject(new Error(`ffmpeg 退出码 ${code}\n${err.slice(-800)}`)));
  });
}

/** 起一个 Python 子进程去调 Modal。stdout/stderr 都转出来，失败时带上尾巴。 */
function runWorker(args) {
  return new Promise((resolve, reject) => {
    // 必须走 fileURLToPath，不能用 .pathname —— pathname 是百分号编码过的，
    // 项目目录叫「十二夜」，编码出来就是 %E5%8D%81%E4%BA%8C%E5%A4%9C，
    // Python 打不开这个文件，整条换音链直接退出码 2。
    // 项目改名成中文的那一刻这个雷就埋下了，之前叫 twelfth-night 时碰不到。
    const script = fileURLToPath(new URL('../worker/cloud_swap_call.py', import.meta.url));
    const child = spawn('python3', [script, ...args], {
      env: { ...process.env, MODAL_PROFILE: 'erised2' },
    });
    let tail = '';
    const keep = (b) => {
      const s = b.toString();
      process.stdout.write(s);
      tail = (tail + s).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker 退出码 ${code}\n${tail}`)));
  });
}
