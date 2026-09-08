#!/usr/bin/env python3
"""长句撑住 —— 让换出来的人声跟住原唱的**包络**，而不是跟住一条固定地板。

用户听到的问题：副歌的长句唱到后面气就没了。原唱是撑住的，我们不是。

为什么现有的两道都治不了：

  follow_envelope.py  设计上"只往下拉，绝不往上推"（注释原话）。这条规则本身没错 ——
                      往上推会把模型在空隙里编的填充物一起放大。但它是一刀切的。

  vocal_support.py    往上抬的目标是 `floor = sung - 13 dB`，一条**固定地板**。
                      长句里原唱一直保持在 -6 dB，我们衰减到 -20 dB，它只把我们抬到
                      -13 dB —— 相对原唱仍然在掉，而且整句被压成一条平线，
                      听感就是"一起一伏、气不足"。

这一道只做一件事：在**原唱确实在唱**的帧里，把我们的包络推向原唱的包络。
那些帧里没有填充物可放大 —— 模型渲染的是真声音，只是撑不住。
判定"确实在唱"要同时满足两条，缺一不可：

  · 原唱在这一帧是**有调的**（voiced）—— 排除气口和辅音
  · 原唱电平高于演唱峰值以下 min_src_db —— 排除乐句之间的空隙

两条都不满足的帧原样放过，交给前面那两道，绝不在空隙里加一分贝。

平滑窗口取 150 ms 而不是 20 ms：要跟的是**乐句尺度**的衰减，不是每个字的起伏。
跟得太细会把演唱本身的强弱抹平，那就成了压缩器。
"""
import argparse
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from math import gcd


def sustain(vocal, source, out, hop_ms=20.0, smooth_ms=150.0,
            max_lift_db=6.0, min_src_db=-30.0):
    x, sr = sf.read(vocal, always_2d=True)
    m = x.mean(1).astype(np.float64)
    s, ssr = sf.read(source, always_2d=True)
    sm = s.mean(1).astype(np.float64)
    if ssr != sr:
        g = gcd(sr, ssr)
        sm = resample_poly(sm, sr // g, ssr // g)
    n = min(len(m), len(sm))
    m, sm = m[:n], sm[:n]

    hop = max(1, int(sr * hop_ms / 1000))
    k = n // hop
    env = lambda a: np.sqrt((a[:k * hop].reshape(k, hop) ** 2).mean(axis=1) + 1e-12)
    eo, es = env(m), env(sm)
    es_db = 20 * np.log10(es + 1e-12)
    sung = np.percentile(es_db, 95)                    # 原唱的演唱电平

    # 原唱的有调判定。用自相关而不是 pyin：这里只要"是不是有基频"这个二值，
    # 不需要准确的音高，而 pyin 在整首歌上要跑很久。
    voiced = np.zeros(k, dtype=bool)
    for i in range(k):
        seg = sm[i * hop:(i + 1) * hop]
        if len(seg) < 8:
            continue
        seg = seg - seg.mean()
        e = float((seg ** 2).sum())
        if e < 1e-10:
            continue
        ac = np.correlate(seg, seg, mode="full")[len(seg) - 1:]
        lo = max(1, int(sr / 800))                     # 800 Hz 以下才算人声基频
        hi = min(len(ac) - 1, int(sr / 60))
        if hi > lo:
            voiced[i] = (ac[lo:hi].max() / (ac[0] + 1e-12)) > 0.30

    singing = voiced & (es_db > sung + min_src_db)

    # 只在 singing 的帧里往上推，而且只往上（往下由前面两道负责，这里不重复干预）
    ratio = np.ones(k)
    want = es[singing] / (eo[singing] + 1e-9)
    ratio[singing] = np.clip(want, 1.0, 10 ** (max_lift_db / 20))

    w = max(3, int(smooth_ms / hop_ms))
    win = np.hanning(w) / np.hanning(w).sum()
    ratio = np.convolve(ratio, win, mode="same")

    g_full = np.repeat(ratio, hop)
    if len(g_full) < n:
        g_full = np.concatenate([g_full, np.full(n - len(g_full), g_full[-1])])
    y = m * g_full[:n]
    pk = float(np.abs(y).max())
    if pk > 0.99:
        y = y / pk * 0.99
    sf.write(out, y.astype("float32"), sr)

    lift_db = 20 * np.log10(ratio + 1e-9)
    used = lift_db > 0.5
    print(f"  在唱的帧 {100*singing.mean():4.1f}%   推上去 {100*used.mean():4.1f}% 的帧，"
          f"中位 +{np.median(lift_db[used]) if used.any() else 0:.1f} dB "
          f"（上限 {max_lift_db:.0f}）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--source", required=True, help="歌自己的人声轨 —— 包络的目标")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-lift-db", type=float, default=6.0)
    ap.add_argument("--min-src-db", type=float, default=-30.0,
                    help="原唱低于演唱峰值这么多的帧，算空隙，不碰")
    ap.add_argument("--smooth-ms", type=float, default=150.0)
    a = ap.parse_args()
    sustain(a.vocal, a.source, a.out, smooth_ms=a.smooth_ms,
            max_lift_db=a.max_lift_db, min_src_db=a.min_src_db)
