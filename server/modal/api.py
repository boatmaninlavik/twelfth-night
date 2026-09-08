"""把 Node 后端整个托管在 Modal 上。

**为什么**：之前 API 跑在开发者的 Mac 上，笔记本一合盖，用户在手机上就连不上，
下单、查进度、传录音全都断。一个要发给别人测试的产品不能依赖某台笔记本开着。

零重写：Modal 的 `@modal.web_server(port)` 会把容器里任何监听该端口的进程暴露成
一个 https 地址，所以 Node 代码一行都不用改，`node src/index.js` 原样跑。

容器里还要有 Python + modal SDK：pipeline 会起子进程去调 Modal 上的换音
（worker/cloud_swap_call.py）和歌词对齐（worker/align.py）。同 workspace 内
函数互调不需要额外凭据，容器自带 —— 但那两个脚本在本机跑时会设 MODAL_PROFILE，
在容器里设会把自带凭据顶掉，所以它们都用 MODAL_TASK_ID 判断了环境。

    MODAL_PROFILE=erised2 modal deploy server/modal/api.py

部署在 erised2：换音的 YingMusic 在这个 workspace，Modal 不能跨 workspace 调函数。
拿到的 https 地址填进 miniprogram/utils/api.js 的 BASE，并加进小程序后台的
服务器域名白名单 —— 那之后就不再需要"不校验合法域名"这个开关，体验版可以发人了。
"""
from pathlib import Path
import modal

app = modal.App("twelfth-api")

_SERVER = Path(__file__).resolve().parent.parent
PORT = 3100

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates", "ffmpeg")
    .run_commands(
        # 必须 22+：@supabase/supabase-js 要原生 WebSocket，Node 20 没有，
        # 起服务时直接抛 "Node.js detected but native WebSocket not found"，
        # 表现为 Modal 等端口超时（真正的原因在容器日志里）。
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "node --version && npm --version",
    )
    .pip_install("modal")                      # 子进程要用它调换音和对齐
    .add_local_file(str(_SERVER / "package.json"), "/app/package.json", copy=True)
    .add_local_file(str(_SERVER / "package-lock.json"), "/app/package-lock.json", copy=True)
    .run_commands("cd /app && npm ci --omit=dev")
    .add_local_dir(str(_SERVER / "src"), "/app/src", copy=True)
    .add_local_dir(str(_SERVER / "worker"), "/app/worker", copy=True)
    # 自带的宋体子集，从 /font/ 提供给小程序 wx.loadFontFace
    .add_local_dir(str(_SERVER / "assets"), "/app/assets", copy=True)
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("twelfth-env")],
    timeout=3600,
    # 一个容器就够：内测量很小，而多容器会让 in-process 的 pipeline 状态对不上。
    max_containers=1,
    # 空闲五分钟回收。这是唯一一个"没人用也在跑"的容器，所以它是省钱的重点；
    # 但它又是用户每一次操作的入口，回收太快每次都要吃一次冷启动
    # （装镜像 + 起 Node，startup_timeout 给到 120 秒是有原因的）。
    # 做歌期间小程序每 8 秒轮询一次，容器本来就热着，这个窗口只影响"两次使用之间"。
    # 真正烧钱的从来不是它（小 CPU 容器闲五分钟 ≈ 一分钱），是 GPU ——
    # 见 cloud_swap.py 里那条注释。
    scaledown_window=300,
)
@modal.web_server(PORT, startup_timeout=120)
def api():
    import subprocess, os
    env = dict(os.environ, PORT=str(PORT))
    # MODAL_PROFILE 是给本机用的，容器里留着会顶掉自带凭据（见文件头）
    env.pop("MODAL_PROFILE", None)
    subprocess.Popen(["node", "src/index.js"], cwd="/app", env=env)
