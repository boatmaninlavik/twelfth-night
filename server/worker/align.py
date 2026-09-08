#!/usr/bin/env python3
"""调 Modal 上的歌词对齐，把结果打到 stdout（JSON）。

跟 swap.py 一样走子进程而不是 Node 直接发 HTTP：Modal 的 Python SDK 是唯一
不用给这个 app 加 HTTP 入口就能调已部署函数的办法。

workspace 写死 erised1 —— 跟换音的 erised2 分开，别让短活排在 A100 长任务后面。
"""
import argparse, json, os, sys

# 只在本机需要指定 profile。容器里 Modal 自带凭据，再设 MODAL_PROFILE 会把它顶掉。
if not os.environ.get("MODAL_TASK_ID"):
    os.environ["MODAL_PROFILE"] = "erised1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="成品音频的 URL")
    ap.add_argument("--lyrics", required=True, help="歌词全文，带 [Verse] 等标记")
    a = ap.parse_args()

    import modal
    fn = modal.Function.from_name("twelfth-align", "align")
    out = fn.remote(a.audio, a.lyrics)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
