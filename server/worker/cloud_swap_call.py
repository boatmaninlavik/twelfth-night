#!/usr/bin/env python3
"""调 Modal 上的换音+精修，把成品 mp3 写到本地文件。

跟旧的 worker/swap.py 的区别：**这台机器上什么都不需要**。
旧路径要 erised-artist 的脚本和它的 venv，意味着开发者的笔记本一合盖，
用户在手机上下的单就永远做不完。现在整条链在 Modal 的容器里跑完。

workspace 是 erised2 —— 那里有已部署的 YingMusic，Modal 不能跨 workspace 调函数。
"""
import argparse, os, sys
from pathlib import Path

# 只在本机需要指定 profile。容器里 Modal 自带凭据，再设 MODAL_PROFILE 会把它顶掉。
if not os.environ.get("MODAL_TASK_ID"):
    os.environ["MODAL_PROFILE"] = "erised2"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--instrumental", required=True)
    ap.add_argument("--user-voice", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=100)
    a = ap.parse_args()

    import modal
    fn = modal.Function.from_name("twelfth-swap", "swap")
    r = fn.remote(a.vocal, a.instrumental, Path(a.user_voice).read_bytes(), a.steps)
    print(r.get("log", "")[-4000:], file=sys.stderr, flush=True)
    if not r.get("mp3"):
        raise RuntimeError("云端没有返回成品")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r["mp3"])
    if r.get("vocal_mp3"):
        Path(str(out).replace(".mp3", "-VOCAL-ONLY.mp3")).write_bytes(r["vocal_mp3"])
    print(f"RESULT {out}")


if __name__ == "__main__":
    main()
