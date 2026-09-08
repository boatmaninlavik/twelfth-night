#!/usr/bin/env python3
"""人声/伴奏比 —— 量它，并把它拉到目标线上。

为什么需要这个：精修链里的 auto_vocal.balance_gain 是
    clip(目标 − 我们自己实测的差, −6, +12)
而我们传 BAL=0.0。伴奏稀的歌（后知后觉）这个式子落在中间，出来正好；
伴奏密的歌（不如沉醉）实测差更大，式子**撞在 −6 的下限上**，
人声被按最大幅度压下去 —— 实测比前者低 5.5 dB。
也就是说：交付出来的响度**随每首歌的伴奏密度漂移**，而不是落在一条线上。

一版一版去调 BAL 是治不好的，那只是给每首歌各配一个数。
这里做的是闭环：混音**之前**量一次真实的人声/伴奏比，跟目标比，差多少补多少。
伴奏密不密都一样，因为量的就是这首歌自己的那个比值。

怎么量：只在**有人在唱**的那些帧上量。
整首平均是错的 —— 前奏、间奏、尾奏里人声是静音，把它们算进去，
间奏越长测出来的人声就越"小"，于是间奏长的歌会被补得越响。
"""
import argparse, math, sys
import numpy as np
import soundfile as sf


def _load(path, sr=44100):
    import librosa
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y, sr


def _frames(y, sr, win=0.10, hop=0.05):
    n, h = int(win * sr), int(hop * sr)
    if len(y) < n:
        return np.zeros((0,))
    idx = np.arange(0, len(y) - n, h)
    return np.sqrt(np.array([np.mean(y[i:i + n] ** 2) for i in idx]) + 1e-20)


def measure(vocal_path, backing_path, floor_db=25.0):
    """返回 (比值 dB, 有人在唱的帧数占比)。"""
    v, sr = _load(vocal_path)
    b, _ = _load(backing_path, sr)
    n = min(len(v), len(b))
    v, b = v[:n], b[:n]
    fv, fb = _frames(v, sr), _frames(b, sr)
    m = min(len(fv), len(fb))
    fv, fb = fv[:m], fb[:m]
    if m == 0:
        raise SystemExit("音频太短")
    # 「在唱」= 人声帧能量在它自己第 95 百分位以下 floor_db 之内。
    # 用百分位不用最大值：一声爆音就会把门限顶上天。
    top = np.percentile(fv, 95)
    voiced = fv > top * (10 ** (-floor_db / 20))
    if voiced.sum() < 10:
        raise SystemExit("找不到足够的有声帧")
    db = lambda x: 20 * math.log10(float(np.sqrt(np.mean(x ** 2))) + 1e-20)
    return db(fv[voiced]) - db(fb[voiced]), float(voiced.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--backing", required=True)
    ap.add_argument("--target", type=float, default=None,
                    help="目标人声/伴奏比 dB；给了就顺便算出该补多少增益")
    ap.add_argument("--apply", help="把增益写进这个文件（人声乘增益后另存）")
    # 钳位是安全带不是调音旋钮：正常修正在 ±4 dB 以内，
    # 超出这个范围多半是前面某一步坏了，硬补只会把坏的补得更响。
    ap.add_argument("--max-lift-db", type=float, default=8.0)
    ap.add_argument("--max-cut-db", type=float, default=8.0)
    a = ap.parse_args()

    ratio, cover = measure(a.vocal, a.backing)
    print(f"人声/伴奏 {ratio:+.2f} dB   有声帧 {cover*100:.0f}%")
    if a.target is None:
        return
    gain = max(-a.max_cut_db, min(a.max_lift_db, a.target - ratio))
    print(f"目标 {a.target:+.2f} dB → 补 {gain:+.2f} dB"
          + ("" if abs(gain) < a.max_lift_db - 1e-6 else "  （已到钳位，前面可能有问题）"))
    if a.apply:
        y, sr = _load(a.vocal)
        sf.write(a.apply, y * (10 ** (gain / 20)), sr)
        print(f"写出 {a.apply}")


if __name__ == "__main__":
    main()
