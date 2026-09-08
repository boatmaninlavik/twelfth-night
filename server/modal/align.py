"""歌词强制对齐 —— 词级时间戳。

erised-web 那套核心对不了中文：它的 ASR 是 WAV2VEC2_ASR_BASE_960H，词表只有 A-Z，
`NON_VOCAB = [^A-Z']` 会把中文整段清空，直接报 "no alignable words in lyrics"。
所以这里用 align_core_zh.py：Demucs 分人声那步照抄（跟语言无关），
ASR 换成 torchaudio 的 MMS_FA（多语言强制对齐），中文按字转拼音去对。

跑在 **erised1**，跟换音的 erised2 分开：换音是 A100 长任务，对齐是短的 CPU 活，
放一起会互相排队。

    MODAL_PROFILE=erised1 modal deploy server/modal/align.py

调用（见 server/worker/align.py）：
    modal.Function.from_name("twelfth-align", "align").remote(audio_url, lyrics)

CPU 不上 GPU：一首歌大约 90 秒，而这一步是在后台跑的 —— 用户已经拿到歌了，
歌词面板晚一分半到没人察觉。挂个 GPU 反而要为零星的请求养一个热容器。
"""
from pathlib import Path
import modal

app = modal.App("twelfth-align")

_HERE = Path(__file__).resolve().parent

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")            # torchaudio ≥2.9 不再自带解码器，靠外部 ffmpeg
    .pip_install("torch==2.5.1", "torchaudio==2.5.1", "numpy<2", "requests", "pypinyin")
    .env({"TORCH_HOME": "/cache/torch"})
    # copy=True 把文件烘进镜像层。用运行时挂载的话，只有从本机发起的调用才会水合，
    # 远程触发的容器会永远排队且不报错。
    .add_local_file(str(_HERE / "align_core_zh.py"), "/root/align_core_zh.py", copy=True)
)

# 模型权重约 680 MB，放卷里，免得每次冷启动重下。
cache = modal.Volume.from_name("twelfth-align-cache", create_if_missing=True)


@app.function(image=image, volumes={"/cache": cache}, cpu=8, timeout=1800,
              scaledown_window=60)
def align(audio_url: str, lyrics: str) -> dict:
    """返回 {lines: [{index,text,start,end,confidence,words:[...]}], meanConfidence, ...}"""
    import sys
    sys.path.insert(0, "/root")
    import align_core_zh as core

    device = core.pick_device()
    core.warm(device)
    workdir = Path("/tmp/one")
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "source.mp3").unlink(missing_ok=True)
    return core.align_song(audio_url, lyrics, workdir, device=device)
