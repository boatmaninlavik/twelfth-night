#!/usr/bin/env python3
"""音色平衡 —— 把换出来的人声的**频段分布**对齐原唱。

这一道解决的是用户反复说的「虚、没气、调大了还是虚」。实测（纯人声对纯人声，
能量占比，只统计在唱的帧）：

    频段        Suno 原唱   换音后     差
    80-250       29.8%     65.5%   +3.4 dB
    250-500      13.4%     29.6%   +3.4
    0.5k-1k      46.3%      4.1%  -10.6      <- 原唱的主体在这，我们几乎是空的
    1k-2k         8.1%      0.6%  -11.7
    2k-4k         1.3%      0.2%   -8.2
    4k-8k         0.5%      0.1%   -7.6

换出来的声音把六成能量堆在基频上，元音的"身体"（500-1k）和送得出去的
"支撑"（2-4k，歌手共振峰）几乎不存在。**这样的声音音量开到多大都是虚的** ——
增益改变不了频谱形状。之前我在音量上折腾了好几轮，方向就是错的。

为什么现有的链子不管：studio_match.py 只处理 12-16 kHz（"光泽"）和 16 kHz 以上
（伪影，切掉）。它是照 "What I See in Her" 调的，那首歌缺的是光泽；我们缺的是
整条中频。不同的麦克风、不同的嗓子，缺的地方不一样。

这算不算"借原唱的频谱"（那是被否过三次的做法）？不算，而且区别很实在：
被否的是**混合波形**和**换掉某个频段的内容**——那会把另一个人的音色细节搬过来。
这里只按倍频程量一条**平滑的增益曲线**，改的是我们自己信号的能量分布，
一个采样点都不从原唱拿。studio_match 做的就是同一件事，只是它只做了最高那两段。
"""
import argparse
import numpy as np
import soundfile as sf


def band_edges(lo=80.0, hi=16000.0, per_oct=3):
    """三分之一倍频程的边界。够细能跟上共振峰，又粗到不会去修单个谐波。"""
    n = int(np.log2(hi / lo) * per_oct)
    return lo * 2 ** (np.arange(n + 1) / per_oct)


def profile(x, sr, n_fft=4096):
    """在唱的帧上，每个频段的能量。"""
    from numpy.lib.stride_tricks import sliding_window_view
    hop = n_fft // 4
    if len(x) < n_fft:
        raise ValueError("音频太短")
    frames = sliding_window_view(x, n_fft)[::hop]
    w = np.hanning(n_fft)
    M = np.abs(np.fft.rfft(frames * w, axis=1)) ** 2
    rms = np.sqrt((frames ** 2).mean(axis=1))
    keep = rms > np.percentile(rms, 70)          # 静音和气口不参与统计
    M = M[keep]
    f = np.fft.rfftfreq(n_fft, 1 / sr)
    return f, M.mean(axis=0)


def match(vocal, original, out, max_lift_db=8.0, max_cut_db=10.0, top_hz=16000.0,
          amount=0.5):
    """amount 是走多远，1.0 = 完全对齐原唱的频段分布。

    **不能走满。** 实测 amount=1.0（那次补了 +11 dB）被身份门拒了：

        timbre  render 1968 Hz | 用户 1099 Hz | 原唱 2343 Hz
        tilt    render -20.3   | 用户 -25.3   | 原唱 -19.4
        REJECT: 亮度和频谱倾斜都更靠近原唱歌手而不是用户

    完全对齐录音棚的频段分布，等于变成那个歌手的音色 —— 正是被否过三次的
    「这不是我的声音」。所以只走一半：补到明显还在用户这一侧、但比原始渲染
    结实得多的位置。门自己的判据就是"离用户比离原唱近"，0.5 留了足够余量。
    """
    x, sr = sf.read(vocal, always_2d=True)
    m = x.mean(1).astype(np.float64)
    a, asr = sf.read(original, always_2d=True)
    am = a.mean(1).astype(np.float64)
    if asr != sr:
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(sr, asr)
        am = resample_poly(am, sr // g, asr // g)

    f, Po = profile(m, sr)
    _, Pa = profile(am, sr)

    edges = band_edges(hi=min(top_hz, sr / 2 * 0.98))
    # 以 250-500 Hz 为锚：那一带两边都有充足能量，用它对齐整体音量，
    # 剩下的差值才是真正的音色差，而不是响度差。
    def band_db(P, lo, hi_):
        sel = (f >= lo) & (f < hi_)
        return 10 * np.log10(P[sel].sum() + 1e-20) if sel.any() else -200.0

    ref_o, ref_a = band_db(Po, 250, 500), band_db(Pa, 250, 500)

    centers, gains = [], []
    for lo, hi_ in zip(edges[:-1], edges[1:]):
        do = band_db(Po, lo, hi_) - ref_o
        da = band_db(Pa, lo, hi_) - ref_a
        if do < -100 or da < -100:
            continue
        centers.append(np.sqrt(lo * hi_))
        gains.append((da - do) * amount)                 # 先留原始差值，钳位放到最后
    centers, gains = np.array(centers), np.array(gains)

    # 把曲线拉成净增益为零 —— 这是"融不进伴奏"的解药。
    #
    # 第一版是纯提升：500 Hz-8 kHz 整段 +6 dB。音色是修对了，但那一带正是吉他、
    # 键盘、军鼓住的地方，人声硬顶上去就是打架，用户的原话是"有杂物感、
    # 没有之前融得自然"。
    #
    # 频段**平衡**只取决于曲线的形状，不取决于它的绝对高度。所以按原唱各段的
    # 能量加权把均值减掉：低频砍、中高频提，形状一模一样，但总能量不变，
    # 不往已经拥挤的频段里多塞东西。整体音量归后面的 auto_vocal 管，不该在这里加。
    w_band = np.array([10 ** (band_db(Pa, lo, hi_) / 10)
                       for lo, hi_ in zip(edges[:-1], edges[1:])][:len(gains)])
    w_band = w_band / w_band.sum()
    gains = gains - float((gains * w_band).sum())

    # max_lift_db=0 表示"只减不加"。这时要把整条曲线压到 0 以下（减去最大值），
    # 而不是直接钳位 —— 钳位会把正的那半截砍平，形状就没了，等于什么都没做。
    # 第一次就踩了这个：曲线出来是 ±0.1 dB 的一条平线。
    #
    # 为什么要有"只减不加"这个模式：这个渲染的高频里大部分是伪影不是人声，
    # mask_hallucination 和 studio_match 当初就是把它们**故意去掉**的。
    # 一提升 2-8 kHz 就等于把清理掉的伪影请回来 —— 用户听到的是"电音又回来了、
    # 不像我了"。只砍低频能达到同样的相对亮度，而且一个伪影都不会被放大。
    if max_lift_db <= 0:
        gains = gains - float(gains.max())
    gains = np.clip(gains, -max_cut_db, max(max_lift_db, 0.0))

    # 曲线要平滑。逐段生硬的增益会让相邻频段之间产生可听的台阶，
    # 而且会去修单个谐波 —— 那正是"电音"的另一种来源。
    k = 5
    win = np.hanning(k) / np.hanning(k).sum()
    gains = np.convolve(np.pad(gains, k // 2, mode="edge"), win, mode="valid")

    curve = np.interp(f, centers, gains, left=gains[0], right=gains[-1])
    curve[f > top_hz] = 0.0                      # 16 kHz 以上归 studio_match 管

    # ── 施加方式：加窗的线性相位 FIR，不是逐帧乘频谱 ──────────────
    #
    # 第一版是在 STFT 里直接 `rfft(seg) * gain` 再 irfft。那等价于跟这条增益曲线的
    # 冲激响应做**循环卷积** —— 而一条在 100 Hz 处有台阶的曲线，冲激响应远长于
    # 4096 样本的帧长，超出的部分会从帧尾绕回帧头，造成时域混叠。听感是金属味、
    # 发糊，也就是用户说的"电音又回来了、不纯粹了"。
    #
    # 关键证据：把曲线改成"只减不加"（不可能放大任何伪影）之后，音质**仍然**比
    # 不做 EQ 的版本差。既然增益的方向不影响，问题就只能在实现上。
    #
    # 正解是把曲线做成一条有限长的 FIR：irfft 拿到冲激响应 → 循环移位到中心
    # → 加窗截断到 taps 长 → 用 fftconvolve 做真正的（线性）卷积。
    # 截断带来的是频响上极轻微的涟漪，比时域混叠好得多。
    from scipy.signal import fftconvolve

    taps = 2049                                   # 奇数，保证线性相位、群延迟是整数
    n_ir = 1 << (int(np.ceil(np.log2(taps))) + 1)
    f_ir = np.fft.rfftfreq(n_ir, 1 / sr)
    mag = np.interp(f_ir, f, 10 ** (curve / 20))
    ir = np.fft.irfft(mag, n_ir)
    ir = np.roll(ir, n_ir // 2)                   # 零相位 → 线性相位，中心对齐
    c0 = n_ir // 2
    half = taps // 2
    ir = ir[c0 - half:c0 + half + 1] * np.hanning(taps)

    y = fftconvolve(m, ir, mode="full")[half:half + len(m)]   # 补掉群延迟

    pk = float(np.abs(y).max())
    if pk > 0.99:
        y = y / pk * 0.99
    sf.write(out, y.astype("float32"), sr)

    show = [(100, 250), (500, 1000), (2000, 4000), (4000, 8000)]
    parts = []
    for lo, hi_ in show:
        sel = (f >= lo) & (f < hi_)
        parts.append(f"{lo//1000 if lo>=1000 else lo}{'k' if lo>=1000 else ''}-"
                     f"{hi_//1000}k {curve[sel].mean():+.1f}")
    print("  音色曲线: " + "  ".join(parts) + " dB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocal", required=True)
    ap.add_argument("--original", required=True, help="歌自己的人声轨")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-lift-db", type=float, default=8.0)
    ap.add_argument("--max-cut-db", type=float, default=10.0)
    ap.add_argument("--amount", type=float, default=0.5,
                    help="走多远。1.0 会越过中线、被身份门拒掉，见 match 的说明")
    a = ap.parse_args()
    match(a.vocal, a.original, a.out, a.max_lift_db, a.max_cut_db, amount=a.amount)
