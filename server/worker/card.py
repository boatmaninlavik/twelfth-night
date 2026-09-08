#!/usr/bin/env python3
"""把一首歌做成一张可以发出去的卡片：小程序码 + 花环 + 题名。

为什么不用微信默认的那张小程序码：默认款是白底加一圈微信绿，每一首歌长得
一模一样，发到群里就是一张"二维码"，不是一件东西。所以这里只向微信要
**透明底、单色**的码（is_hyaline + line_color），把它当一个图形元素，
自己排一张纸。

每首歌都不一样，但不是随机的 —— 随机意味着同一首歌每次生成都变。
变化全部由 order id 的哈希决定，同一首歌永远得到同一张卡：
  · 版式      四选一
  · 花环转角  哈希决定起始角度
  · 花的位置  在环上重新分布
  · 配色      跟着场合走（求婚是干玫瑰，道歉是青灰…）

用 PIL 而不是 SVG/浏览器：服务端不需要再养一个 headless chrome。
"""
import argparse, hashlib, io, math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SONGTI = "/System/Library/Fonts/Supplemental/Songti.ttc"
DIDOT  = "/System/Library/Fonts/Supplemental/Didot.ttc"

# 跟 app.wxss 里那套变量一一对应，卡片和小程序必须是同一套颜色
PAPER      = (247, 244, 237)
PAPER_SUNK = (239, 234, 220)
INK        = (26, 24, 34)
INK_SOFT   = (75, 70, 85)
MUTED      = (145, 138, 120)
RULE       = (221, 214, 196)

# 场合 → 那点旧金。ASCII slug 跟 utils/theme.js 保持一致。
BRASS = {
    "propose":     (156,  90,  97),
    "anniversary": (168, 135,  78),
    "parents":     (158, 106,  69),
    "apology":     ( 93, 109, 128),
    "birthday":    (120,  98, 146),
}
# 植物那五个饱和色，跟 app.wxss 的 --leaf-* / --bloom-* 同源
LEAF  = [(23, 121, 94), (14, 139, 139), (39, 73, 196)]
BLOOM = [(233, 161, 59), (199, 75, 147)]


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


def leaf(draw_on, cx, cy, w, h, ang, color):
    """一片叶子：椭圆画在自己的小图层上转好角度再贴回去。"""
    pad = int(max(w, h))
    lay = Image.new("RGBA", (pad * 2, pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.ellipse([pad - w / 2, pad - h / 2, pad + w / 2, pad + h / 2], fill=color + (255,))
    lay = lay.rotate(ang, resample=Image.BICUBIC)
    draw_on.alpha_composite(lay, (int(cx - pad), int(cy - pad)))


def bloom(draw_on, cx, cy, r, petal, core):
    """五瓣花 + 一个异色花心。花心那点对比是花之所以是花。"""
    pad = int(r * 2.2)
    lay = Image.new("RGBA", (pad * 2, pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    pw, dist = r * 0.80, r * 0.62
    for n in range(5):
        a = math.radians(n * 72)
        px, py = pad + dist * math.sin(a), pad - dist * math.cos(a)
        d.ellipse([px - pw / 2, py - pw / 2, px + pw / 2, py + pw / 2], fill=petal + (255,))
    d.ellipse([pad - r * 0.30, pad - r * 0.30, pad + r * 0.30, pad + r * 0.30], fill=core + (255,))
    draw_on.alpha_composite(lay, (int(cx - pad), int(cy - pad)))


def wreath(img, cx, cy, R, seed, n_leaf=34, n_bloom=5):
    """仲夏花环。起始角和花的分布都由 seed 决定，所以每首歌的环都不同。

    叶子要多到彼此叠压才像"编"出来的。第一版 18 片散在环上，间距大过叶长，
    看起来是撒了一圈彩纸而不是一个花环 —— 密度本身就是这个图形的意思。
    """
    off = (seed % 360)
    k = R / 104.0
    for i in range(n_leaf):
        deg = off + 360 / n_leaf * i
        a = math.radians(deg)
        out = (7 if i % 2 else -6) * k        # 一片压外一片压内，错落就是编织
        rr = R + out
        x, y = cx + rr * math.sin(a), cy - rr * math.cos(a)
        w = [34, 29, 31][i % 3] * k
        tilt = -deg + (112 + (20 if i % 2 else -20))
        leaf(img, x, y, w, w * 0.46, tilt, LEAF[i % 3])
    for j in range(n_bloom):
        # 花不等分：用 seed 打散，避免看起来像钉了一圈钉子
        a = math.radians(off + 360 / n_bloom * j + ((seed >> (j * 3)) % 30) - 15)
        rr = R + 4 * k
        x, y = cx + rr * math.sin(a), cy - rr * math.cos(a)
        r = (27 if j == 0 else 20) * k
        bloom(img, x, y, r, BLOOM[j % 2], BLOOM[(j + 1) % 2])


def star(d, cx, cy, R, color):
    """十二道芒：四长八短。题名就在这颗星里。"""
    for i, (deg, lng) in enumerate([(0, 1), (90, 1), (30, 0), (60, 0), (120, 0), (150, 0)]):
        L = R if lng else R * 0.6
        a = math.radians(deg)
        dx, dy = L * math.sin(a), L * math.cos(a)
        d.line([cx - dx, cy - dy, cx + dx, cy + dy], fill=color + (255,), width=max(3, R // 16))


def build(qr_png: bytes, title: str, to_name: str, occasion_slug: str, seed_src: str) -> bytes:
    seed = int(hashlib.sha256(seed_src.encode()).hexdigest()[:8], 16)
    layout = seed % 4
    brass = BRASS.get(occasion_slug, BRASS["anniversary"])

    W, H = 1080, 1540
    img = Image.new("RGBA", (W, H), PAPER + (255,))
    d = ImageDraw.Draw(img)

    f_title = font(SONGTI, 92, 2)
    f_ded   = font(SONGTI, 34, 0)
    f_small = font(SONGTI, 28, 0)
    f_en    = font(DIDOT, 30)

    # ── 顶部：花环 + 环心的星 ─────────────────────────────
    cx, cy, R = W // 2, 318, 168
    wreath(img, cx, cy, R, seed)
    star(d, cx, cy, 62, INK)

    # ── 题名 ──────────────────────────────────────────
    y = 528
    tw = d.textlength(title, font=f_title)
    d.text((cx - tw / 2, y), title, font=f_title, fill=INK + (255,))
    y += 126

    if to_name:
        t = f"致 {to_name}"
        d.text((cx - d.textlength(t, font=f_ded) / 2, y), t, font=f_ded, fill=brass + (255,))
    y += 64

    # 界栏。版式 0/2 用短线，1/3 用两侧线夹住 —— 四种版式的差别之一
    if layout in (0, 2):
        d.line([cx - 60, y, cx + 60, y], fill=RULE + (255,), width=2)
    else:
        d.line([cx - 200, y, cx - 70, y], fill=RULE + (255,), width=2)
        d.line([cx + 70, y, cx + 200, y], fill=RULE + (255,), width=2)
    y += 54

    # ── 小程序码。要的是透明底单色，所以能直接压在纸上 ──────────
    qr = Image.open(io.BytesIO(qr_png)).convert("RGBA")
    QS = 500
    qr = qr.resize((QS, QS), Image.LANCZOS)
    qx, qy = cx - QS // 2, y

    # 版式 1/3 在码后面垫一块微微下沉的纸，像贴上去的一张票
    if layout in (1, 3):
        d.rectangle([qx - 34, qy - 34, qx + QS + 34, qy + QS + 34], fill=PAPER_SUNK + (255,))
    img.alpha_composite(qr, (qx, qy))
    y += QS + 56

    # ── 页脚 ──────────────────────────────────────────
    tip = "扫码听这首歌"
    d.text((cx - d.textlength(tip, font=f_small) / 2, y), tip, font=f_small, fill=MUTED + (255,))
    y += 52
    en = "If music be the food of love, play on"
    d.text((cx - d.textlength(en, font=f_en) / 2, y), en, font=f_en, fill=MUTED + (255,))
    y += 46
    cite = "十二夜"
    d.text((cx - d.textlength(cite, font=f_small) / 2, y), cite, font=f_small, fill=brass + (255,))

    out = io.BytesIO()
    img.convert("RGB").save(out, "PNG")
    return out.getvalue()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--qr", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--to-name", default="")
    ap.add_argument("--occasion", default="anniversary")
    ap.add_argument("--seed", required=True, help="order id —— 同一首歌永远同一张卡")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    Path(a.out).write_bytes(
        build(Path(a.qr).read_bytes(), a.title, a.to_name, a.occasion, a.seed))
    print("wrote", a.out)
