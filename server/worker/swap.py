#!/usr/bin/env python3
"""第二波：把歌里的主唱换成用户的声音。

为什么是一个 Python 脚本而不是 Node 直接调 HTTP：`modal/yingmusic.py` 里只有
`@app.function`，没有 `@modal.fastapi_endpoint`，所以那个 app 根本没有 HTTP 入口。
加一个就要重新 build + deploy + 冷启动，而 handoff 明确说那不是"随手重试"的代价。
用 `modal.Function.from_name` 直接查已部署的函数，一行都不用重部署。

workspace 固定写死成 erised2，不读当前激活的 profile —— 这台机器现在激活的是
`erased-video`，正是 handoff 警告的那种 stale default（有一次花了约 $100）。
"""
import argparse, os, shutil, subprocess, sys, tempfile, urllib.request
from pathlib import Path

ART = Path(os.environ.get("ERISED_ARTIST", Path.home() / "Desktop/erised-artist"))
PY_VENV = ART / ".venv-master/bin/python"
APP = os.environ.get("YING_APP", "erised-ying-20260904e")

# 只在本机需要指定 profile。容器里 Modal 自带凭据，再设 MODAL_PROFILE 会把它顶掉。
if not os.environ.get("MODAL_TASK_ID"):
    os.environ["MODAL_PROFILE"] = "erised2"


def log(m):
    print(m, flush=True)


def run(cmd, **kw):
    p = subprocess.run(cmd, text=True, capture_output=True, **kw)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, cmd))}\n{p.stdout[-1200:]}\n{p.stderr[-1800:]}")
    return p


def fetch(url, dest):
    if url.startswith("http"):
        # 必须带浏览器 UA。urlretrieve 默认发 "Python-urllib/3.x"，
        # kie.ai 的文件服务器 (tempfile.aiquickdraw.com) 直接拿它当爬虫挡掉，
        # 回 403 —— 同一个链接 curl 是 200。这一步失败整条换音链就断在这儿。
        req = urllib.request.Request(url, headers={
            "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/125.0 Safari/537.36"),
        })
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    else:
        shutil.copy(url, dest)
    return dest


def median_f0(path):
    """一段音频的中位基频。用来定"歌唱在哪个高度"。"""
    import numpy as np, librosa
    y, sr = librosa.load(str(path), sr=16000, mono=True)
    f0, _, _ = librosa.pyin(y, fmin=60, fmax=800, sr=sr, frame_length=1024)
    v = f0[~np.isnan(f0)]
    if len(v) == 0:
        raise RuntimeError(f"{path} 里检测不到音高")
    return float(np.median(v))


def narrow_to_song(ref_src, song_median, dest, half_st=4.0, min_sec=2.0, want_sec=9.0):
    """把参考收窄到歌的音域附近，**并且只留这个人唱得最实的那几段**。

    两个条件缺一不可：

    音高：只要落在歌中位 ±half_st 半音以内的窗口。实测数据 ——
        参考跨度 12.9 半音 -> 换出来整体 +12.0 半音，96% 的帧高一个八度，报废
        参考跨度  6.3 半音 -> +0.0 半音，99.6% 与原唱同调
      YingMusic 按参考的音域定目标高度，而它锚的是**上沿**不是中位。

    音质：窗口按 CPP（倒谱峰突出度，嗓音支撑度的标准指标）排序，只取最好的。
      这一条我第一版漏了，代价很直接 ——
        用户录音整段     CPP 中位 13.59，最好的 10% 到 17.43
        curate_ref 挑的  CPP 中位 14.69
        我只按音高切的    CPP 中位 14.35   <- 模型看到的是"平均水平"
      人唱音阶时不可能每一秒都在状态，虚的那几秒混进去，模型学到的就是一个
      气不足的人。挑最实的那几秒不是美化 —— 素材全是他自己唱的，
      只是别拿他最差的几秒去定义他。

    curate_ref 本来就是按 CPP 排的，但它的音高筛选看的是"歌的音域"，而 2 轨
    分离的人声轨混着和声，测出的音域能宽到 9.7 半音，条件一松就放进太宽的参考。
    所以这里两条自己都做一遍。
    """
    import numpy as np, soundfile as sf, sys, librosa
    sys.path.insert(0, str(ART / "svc"))
    from curate_ref import cpp_frame                  # 用它的 CPP，别自己另算一套

    SR, HOP = 44100, 512
    y, sr = sf.read(str(ref_src), always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)

    # ── 第一步：按帧紧筛音高 ────────────────────────────────
    # 必须按帧（12 ms）而不是按 0.5 秒的窗口。扫音阶时一个窗口里音高一直在动，
    # 拿窗口的平均 f0 去筛，选出来的跨度能到 24 半音 —— 那正是会引发整体
    # 移调一个八度的宽度。实测：6.3 半音 -> 不移调；12.9 半音 -> +12 半音。
    f0, _, _ = librosa.pyin(y, fmin=60, fmax=800, sr=SR,
                            frame_length=2048, hop_length=HOP)
    lo, hi = song_median * 2 ** (-half_st / 12), song_median * 2 ** (half_st / 12)
    ok = (~np.isnan(f0)) & (f0 >= lo) & (f0 <= hi)

    runs, start = [], None
    for k, v in enumerate(ok):
        if v and start is None:
            start = k
        elif not v and start is not None:
            if (k - start) * HOP / SR > 0.25:         # 太碎的片段全是接缝
                runs.append((start * HOP, k * HOP))
            start = None
    if start is not None:
        runs.append((start * HOP, len(ok) * HOP))
    if not runs:
        raise RuntimeError(
            f"参考里没有落在歌音域（{lo:.0f}-{hi:.0f} Hz）的片段 —— 换不了音")

    # ── 第二步：在合格的片段里按 CPP 挑最实的 ──────────────────
    # 人唱音阶不可能每一秒都在状态。虚的那几秒混进去，模型学到的就是一个气不足
    # 的人。挑最实的几秒不是美化 —— 素材全是他自己唱的，只是别拿他最差的几秒
    # 去定义他。实测这位用户：整段 CPP 中位 13.59，最好的 10% 到 17.43。
    scored = []
    for a, b in runs:
        seg = y[a:b]
        c, _ = cpp_frame(seg[:min(len(seg), int(0.5 * SR))], SR)
        scored.append((c, a, b))
    scored.sort(key=lambda t: -t[0])

    keep, total = [], 0.0
    for c, a, b in scored:
        keep.append((a, b, c))
        total += (b - a) / SR
        if total >= want_sec:
            break
    if total < min_sec:                               # 好的不够，就全都要
        keep = [(a, b, c) for c, a, b in scored]
        total = sum((b - a) for a, b, _ in keep) / SR

    keep.sort()                                       # 按时间排，乐句才连得上
    fade = int(0.02 * SR)
    ramp = np.linspace(0, 1, fade)
    out = []
    for a, b, _ in keep:
        seg = y[a:b].copy()
        if len(seg) > 2 * fade:
            seg[:fade] *= ramp
            seg[-fade:] *= ramp[::-1]
        out.append(seg)
    out = np.concatenate(out)

    secs = len(out) / SR
    if secs < min_sec:
        raise RuntimeError(
            f"参考只剩 {secs:.1f}s（要 >= {min_sec}s）—— 唱的音域跟这首歌对不上，"
            f"送去 GPU 也是废片")
    sf.write(str(dest), out, SR)

    f2, _, _ = librosa.pyin(out, fmin=60, fmax=800, sr=SR, frame_length=2048)
    v2 = f2[~np.isnan(f2)]
    p5, p95 = np.percentile(v2, 5), np.percentile(v2, 95)
    span = 12 * np.log2(p95 / p5)
    log(f"参考 {secs:.1f}s  中位 {np.median(v2):.0f} Hz  跨度 {span:.1f} 半音 "
        f"(歌 {song_median:.0f} Hz)  CPP 中位 {np.median([c for _, _, c in keep]):.2f}")
    if span > 8.0:
        raise RuntimeError(f"收窄后仍有 {span:.1f} 半音，超过 8 —— 模型会整体移调，先不烧 GPU")
    return dest

def to_wav(src, dest, sr=44100):
    run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ar", str(sr), str(dest)])
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True, help="歌自己的人声轨（分轨结果）")
    ap.add_argument("--instrumental", required=True, help="伴奏轨")
    ap.add_argument("--user-voice", required=True, help="用户唱的音阶")
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=100,
                    help="扩散步数。50 步快一倍，质量代价未测")
    a = ap.parse_args()

    if not PY_VENV.exists():
        sys.exit(f"找不到 {PY_VENV} —— ERISED_ARTIST 指对了吗？")

    w = Path(tempfile.mkdtemp(prefix="tn_swap_"))
    log(f"工作目录 {w}")
    try:
        _run(a, w)
    finally:
        # 一次跑下来这里面有 ~160 MB 的 wav（源、伴奏、8 道精修各一份）。
        # 以前不删，跑十几次就能把盘占满 —— 而磁盘一满，ffmpeg 写最后那个
        # 混音文件会失败，整单在最后一步报废。
        #
        # TN_KEEP_WORK=1 保留现场。调精修参数时用得上：换音那步要 A100，
        # 而 8 道精修全在本地 CPU 跑 —— 留着 lead_converted.wav 就能反复重跑
        # 精修而不用再烧一次 GPU。
        if os.environ.get("TN_KEEP_WORK") == "1":
            log(f"保留工作目录（TN_KEEP_WORK=1）：{w}")
        else:
            shutil.rmtree(w, ignore_errors=True)


def _run(a, w):
    lead_src = to_wav(fetch(a.vocal, w / "vocal.dl"), w / "lead_src.wav")
    instr = to_wav(fetch(a.instrumental, w / "instr.dl"), w / "instr.wav")
    user_raw = to_wav(fetch(a.user_voice, w / "user.dl"), w / "user_raw.wav")

    # 参考录音必须收窄到歌的音域再喂给模型，否则模型整体移调，整首报废。
    # 先用 curate_ref 按音质挑（它会扔掉气声、噪声大的窗口），
    # 再按歌的中位音高收窄 —— 两步都要，少哪一步都出问题：
    #   只挑音质不收窄 -> 12.9 半音宽 -> +12 半音，报废
    #   只收窄不挑音质 -> 可能全是最差的那几秒
    ref_q = w / "ref_curated.wav"
    log("按音质挑参考片段…")
    run([str(PY_VENV), str(ART / "svc/curate_ref.py"),
         "--source", str(lead_src), "--refs", str(user_raw), "--out", str(ref_q)])

    song_med = median_f0(lead_src)
    ref = w / "ref_narrow.wav"
    try:
        narrow_to_song(ref_q, song_med, ref)
    except RuntimeError as e:
        # curate_ref 挑出来的可能太短，收不出东西 —— 退回原始录音再收窄
        log(f"从 curate_ref 的结果收窄失败（{e}），改用原始录音")
        narrow_to_song(user_raw, song_med, ref)

    log(f"调 Modal {APP}.convert（{a.steps} 步）…")
    import modal
    convert = modal.Function.from_name(APP, "convert")
    converted = convert.remote(lead_src.read_bytes(), instr.read_bytes(),
                               ref.read_bytes(), a.steps)
    lead_conv = w / "lead_converted.wav"
    lead_conv.write_bytes(converted)
    log(f"换音回来了 {lead_conv.stat().st_size // 1024} KB")

    # 便宜档分轨（separate_vocal，10 credits）只给人声+伴奏两轨，拿不到独立和声。
    # swap_v2.sh 要一个和声轨原样混回去，这里给它一段静音：和声本来就还留在
    # vocal 轨里，再叠一次会让它响两倍。想要真和声轨就得换 50 credits 的多轨档。
    #
    # 长度必须跟伴奏一样长，不能图省事给 1 秒。swap_v2.sh 里合成伴奏那一步是
    #     n = min(len(inst), len(bv)); mix = inst[:n] + bv[:n]
    # 给 1 秒静音的话 n 就是 1 秒，整条伴奏被截掉，成品出来是一段几乎纯人声 ——
    # 而且不报任何错，只有对着频谱看低频能量才看得出来（13.6% vs 应有的 62%）。
    instr_secs = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", str(instr)]).stdout.strip())
    bv = w / "bv_silent.wav"
    run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "anullsrc=r=44100:cl=mono", "-t", f"{instr_secs:.3f}", str(bv)])

    out = Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    # 不覆盖 BAL，用 swap_v2.sh 的 0.0。
    #
    # 我试过"按原唱的实测值传"（这首歌是 +6.7），结果人声反而更突出：
    #   BAL=0.0  人声比原版突出 +1.8 dB
    #   BAL=6.7  人声比原版突出 +4.2 dB
    # 因为 auto_vocal.balance_gain 是 clip(target - 我们自己的实测差, -6, +12)：
    # 传 0.0 时它撞在 -6 的下限上、把人声往下压到极限；传 6.7 反而让它往上抬。
    # 目标值不能直接拿原唱的数填 —— 增益是在我们的人声上算的，不是原唱上。
    # 想让人声再退后一点，得改的是那个 -6 的钳位，不是这个目标值。
    log("跑精修链…")
    env = dict(os.environ, LEAD_SRC=str(lead_src), BV_SRC=str(bv), WORK=str(w / "chain"))
    # 走我们自己的 worker/polish.sh，不直接调 swap_v2.sh。
    # 它以 swap_v2.sh 为准，只有三处有意的偏离（参数、多一道 sustain、不覆盖 BAL），
    # 每一处都在那个文件里注明了原因和实测依据。
    p = subprocess.run(["bash", str(Path(__file__).resolve().parent / "polish.sh"),
                        str(lead_conv), str(bv), str(instr), str(ref), str(out)],
                       text=True, capture_output=True, env=env)
    log(p.stdout[-2500:])
    if p.returncode != 0:
        raise RuntimeError(f"精修链失败:\n{p.stderr[-2500:]}")

    log(f"RESULT {out}")


if __name__ == "__main__":
    main()
