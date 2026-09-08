"""换音 + 精修，整条跑在 Modal 上。

**为什么必须搬上来**：原来精修链跑在开发者的 Mac 上（erised-artist 的脚本和它的
venv），意味着笔记本一合盖，用户在手机上下的单就永远做不完。一个要交付给别人的
产品不能是这样。搬上来之后整条链只剩 HTTP 和 Modal，Node 服务放哪都行。

跑在 **erised2**：这里要调同一个 workspace 里已部署的 `erised-ying-20260904e.convert`，
Modal 不能跨 workspace 调函数。歌词对齐在 erised1，跟这边分开。

换音（A100）和精修（CPU）放在**同一个函数**里：中间产物是几十 MB 的 wav，
拆成两个函数就要在网络上来回搬。代价是精修那两三分钟也占着 GPU 容器 ——
用 A10G 而不是 A100 之外的优化留到有量再说。

erised-artist 的脚本原样拷进镜像、**一个字节不改**：它们里面写死了
`~/Desktop/erised-artist` 和 `/Users/thuscodedzara/...`，所以容器里把这两条路径
用软链接搭出来，而不是去改他们的文件 —— 改了就会跟上游漂开，而那些脚本的每个
参数都是实测调出来的。

    MODAL_PROFILE=erised2 modal deploy server/modal/cloud_swap.py
"""
from pathlib import Path
import modal

app = modal.App("twelfth-swap")

_HERE = Path(__file__).resolve().parent
_SERVER = _HERE.parent
_ART = Path.home() / "Desktop" / "erised-artist"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libsndfile1", "xz-utils", "curl")
    # Debian 自带的 ffmpeg 太老：auto_vocal.py 用的 adynamicequalizer 里
    # `mode=cutabove` 在旧版不存在，报 "Undefined constant"。而 finish_v2.sh
    # 有 set -e 且那一步是 >/dev/null 2>&1，失败就是无声中止 ——
    # 表现为"8 道全跑完然后什么都没有"，最难查的那种。所以装静态新版。
    .run_commands(
        "curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
        " -o /tmp/ff.tar.xz",
        "mkdir -p /tmp/ff && tar -xJf /tmp/ff.tar.xz -C /tmp/ff --strip-components=1",
        "install -m755 /tmp/ff/ffmpeg /usr/local/bin/ffmpeg",
        "install -m755 /tmp/ff/ffprobe /usr/local/bin/ffprobe",
        "rm -rf /tmp/ff /tmp/ff.tar.xz",
        "ffmpeg -hide_banner -version | head -1",
    )
    # pyworld 是 debreath.py 用的（第 5 道，压呼吸），它要编译，所以带上 build 工具。
    # 装包清单是照着 svc/*.py 的 import 扒出来的，缺一个整条链就断在中途。
    .apt_install("build-essential")
    .pip_install("numpy<2", "cython", "scipy", "soundfile", "librosa", "pyworld", "modal")
    # 脚本按它们期望的位置摆好，避免改动上游
    .add_local_dir(str(_ART / "svc"), "/root/erised-artist/svc", copy=True)
    .add_local_dir(str(_SERVER / "worker"), "/root/tn/worker", copy=True)
    .run_commands(
        "mkdir -p /root/Desktop /Users/thuscodedzara/Desktop /root/erised-artist/.venv-master/bin",
        # svc/finish_v2.sh 里写着 R=~/Desktop/erised-artist
        "ln -sfn /root/erised-artist /root/Desktop/erised-artist",
        # 它内嵌的一段 python 里写着绝对路径 /Users/thuscodedzara/Desktop/erised-artist/svc
        "ln -sfn /root/erised-artist /Users/thuscodedzara/Desktop/erised-artist",
        # 脚本一律通过 $R/.venv-master/bin/python 调解释器
        "ln -sf $(which python) /root/erised-artist/.venv-master/bin/python",
        "chmod +x /root/tn/worker/polish.sh",
    )
    .env({"ERISED_ARTIST": "/root/erised-artist", "POLISH_PY": "python"})
)


# **不要 GPU。**
# 这个容器一次跑十八分钟，但它一秒也没用到显卡：换音那一步是
# `convert.remote()` 调另一个 app（erised-ying-20260904e），GPU 在那边、
# 按那边的时长计费。这里剩下的全是 ffmpeg、curate_ref 和 8 道 CPU 精修链
# （镜像里连 torch 都没装，想用也用不了）。
# 早先挂着 gpu="A100" 时，每首歌白付十八分钟 A100 ≈ $1.1；改成纯 CPU 之后
# 同样这十八分钟 ≈ $0.075，差 15 倍。
#
# scaledown_window 写死 60 秒、不吃 Modal 的默认值：默认值是会变的，
# 而这条决定的是"没人做歌时还烧不烧钱"。
@app.function(image=image, timeout=3600, cpu=8, scaledown_window=60)
def swap(vocal_url: str, instrumental_url: str, user_voice: bytes,
         steps: int = 100) -> dict:
    """一首歌，从分轨到成品。

    返回 {"mp3": bytes, "vocal_mp3": bytes, "log": str}。
    失败直接抛，调用方按异常处理 —— 半成品不该被当成结果交出去。
    """
    import subprocess, sys, tempfile, os, io
    from pathlib import Path as P

    # 这个文件叫 cloud_swap 而不是 swap，是有意的：worker/swap.py 也叫 swap，
    # 两边同名的话 Modal 入口自己已经在 sys.modules 里，`import swap` 会拿到它自己
    # （踩过：AttributeError: module 'swap' has no attribute 'to_wav'）。
    sys.path.insert(0, "/root/tn/worker")
    import swap as local          # 复用 narrow_to_song / median_f0，不重写一份

    w = P(tempfile.mkdtemp(prefix="tn_"))
    log = []

    def sh(cmd, **kw):
        p = subprocess.run(cmd, text=True, capture_output=True, **kw)
        log.append((p.stdout or "") + (p.stderr or ""))
        if p.returncode != 0:
            # 尾巴要留够。第一次只留 1500 字，而真正的报错在 stderr 的最后，
            # 被截掉了 —— 日志看起来"跑完了 8 道就没了"，什么线索都没有。
            raise RuntimeError(f"{' '.join(map(str, cmd))} 退出码 {p.returncode}\n"
                               + "=== stdout ===\n" + (p.stdout or "")[-3000:]
                               + "\n=== stderr ===\n" + (p.stderr or "")[-6000:])
        return p

    lead_src = local.to_wav(local.fetch(vocal_url, w / "v.dl"), w / "lead_src.wav")
    instr = local.to_wav(local.fetch(instrumental_url, w / "i.dl"), w / "instr.wav")
    (w / "user.dl").write_bytes(user_voice)
    user_raw = local.to_wav(w / "user.dl", w / "user_raw.wav")

    # 参考：先按音质挑，再按歌的中位音高收窄。两步都要 —— 只挑音质会放进
    # 12 半音宽的参考，模型会把整首移调一个八度（实测 +12.0，96% 的帧）。
    ref_q = w / "ref_curated.wav"
    sh(["python", "/root/erised-artist/svc/curate_ref.py",
        "--source", str(lead_src), "--refs", str(user_raw), "--out", str(ref_q)])
    song_med = local.median_f0(lead_src)
    ref = w / "ref.wav"
    try:
        local.narrow_to_song(ref_q, song_med, ref)
    except RuntimeError as e:
        log.append(f"从 curate_ref 结果收窄失败（{e}），改用原始录音")
        local.narrow_to_song(user_raw, song_med, ref)

    # 换音。调同 workspace 里已部署的 YingMusic。
    convert = modal.Function.from_name("erised-ying-20260904e", "convert")
    conv = convert.remote(lead_src.read_bytes(), instr.read_bytes(),
                          ref.read_bytes(), steps)
    lead_conv = w / "lead_converted.wav"
    lead_conv.write_bytes(conv)
    log.append(f"换音回来 {len(conv)//1024} KB")

    # 和声轨给一段跟伴奏等长的静音。长度必须一样 —— polish.sh 里合成伴奏是
    # inst + pad(bv)，早先给 1 秒静音时整条伴奏被截成 1 秒，成品几乎是纯人声。
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(instr)],
                         text=True, capture_output=True).stdout.strip()
    bv = w / "bv.wav"
    sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=mono", "-t", dur, str(bv)])

    out = w / "final.wav"
    env = dict(os.environ, LEAD_SRC=str(lead_src), WORK=str(w / "chain"),
               ERISED_ARTIST="/root/erised-artist", POLISH_PY="python")
    sh(["bash", "/root/tn/worker/polish.sh", str(lead_conv), str(bv), str(instr),
        str(ref), str(out)], env=env)

    mp3 = w / "final.mp3"
    voc = w / "vocal.mp3"
    sh(["ffmpeg", "-v", "error", "-y", "-i", str(out),
        "-codec:a", "libmp3lame", "-b:a", "256k", str(mp3)])
    vonly = P(str(out).replace(".wav", "-VOCAL-ONLY.wav"))
    if vonly.exists():
        sh(["ffmpeg", "-v", "error", "-y", "-i", str(vonly),
            "-codec:a", "libmp3lame", "-b:a", "256k", str(voc)])

    return {
        "mp3": mp3.read_bytes(),
        "vocal_mp3": voc.read_bytes() if voc.exists() else b"",
        "log": "\n".join(log)[-6000:],
    }


@app.function(image=image, timeout=600)
def probe(cmd: list) -> str:
    """在容器里执行一条命令并回传输出。

    存在的理由：finish_v2.sh 里 `auto_vocal.py ... >/dev/null 2>&1` 把错误吞掉了，
    而 finish_v2.sh 没有 set -e，于是它失败之后脚本继续往下跑、在别处以别的方式炸，
    日志里只剩一个退出码。容器里没法交互，只能用这个把真相取出来。
    """
    import subprocess
    p = subprocess.run(cmd, text=True, capture_output=True)
    return f"rc={p.returncode}\n--- stdout ---\n{p.stdout[-4000:]}\n--- stderr ---\n{p.stderr[-4000:]}"
