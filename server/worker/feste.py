#!/usr/bin/env python3
"""费斯特 —— 等待页上的那个小丑。

《第十二夜》里唯一清醒的人。别人喝醉、错认、装疯，只有他在旁边弹琴唱真话，
剧里几首歌都是他唱的。让他来陪用户等这首歌，比一个转圈的加载图标贴切得多。

画法跟花环同一套语言，不是插画：平涂、无描边、无渐变、无阴影，形状简到不能再简，
颜色用同一组（铬绿/孔雀/钴蓝/藏红花/洋红）。马蒂斯剪纸那条线。

造型照用户给的剧照：红圆顶礼帽、宽松红套装、深色马甲配白领结、手上和空中的帽子。
不画传统费斯特那身彩条小丑装和皱领 —— 那是网上搜出来的刻板形象，
用户明确要的是剧照里那个杂技团小丑。

红色用朱砂（#C8402F）不用正红：正红一上来整张图就是年货海报，
这是用户前面对花环颜色的原话。朱砂偏暖偏沉，跟纸和墨放在一起才站得住。

刻意不画嘴：一个笑脸会立刻把它变成儿童插画。两点眼睛加一个鼻子就够。

输出 SVG。小程序里用 <image src="data:image/svg+xml;base64,..."> 引。
"""
import base64, math

INK      = "#1A1822"
PAPER    = "#F7F4ED"
SKIN     = "#EFE3D2"
LEAF_A   = "#17795E"   # 铬绿
LEAF_B   = "#0E8B8B"   # 孔雀
LEAF_C   = "#2749C4"   # 钴蓝
BLOOM_A  = "#E9A13B"   # 藏红花
BLOOM_B  = "#C74B93"   # 洋红

RED      = "#C8402F"   # 朱砂。正红太土（用户原话），这个偏暖偏沉
RED_DK   = "#A63328"   # 帽檐和暗部
VEST     = "#26333D"   # 马甲的深青灰

# 画布取正方形：非方形的 viewBox 在各种渲染器/容器里会被按不同规则填充或裁切，
# 方形没有歧义。图形本身仍是竖的，四周留白当构图用。
W, H = 620, 620


def bowler(cx, cy, w, tilt=0.0, red=None, dark=None):
    """一顶圆顶礼帽。剧照里他手上和空中一共四顶，这是整张图的母题。"""
    red = red or RED
    dark = dark or RED_DK
    h = w * 0.52
    g = f'<g transform="rotate({tilt} {cx} {cy})">' if tilt else "<g>"
    # 纯红，不加帽带 —— 这个尺寸下一条浅色横杠只会让帽子显脏
    return (g
            + f'<ellipse cx="{cx}" cy="{cy}" rx="{w/2:.1f}" ry="{w*0.11:.1f}" fill="{dark}"/>'
            + f'<path d="M{cx-w*0.31:.1f} {cy} C {cx-w*0.31:.1f} {cy-h:.1f} '
              f'{cx+w*0.31:.1f} {cy-h:.1f} {cx+w*0.31:.1f} {cy} Z" fill="{red}"/>'
            + "</g>")


def hat_svg(w=110) -> str:
    """单独一顶帽子。等待页上要抛三顶，每顶是一个独立的 <image>，
    这样才能各走各的抛物线、各转各的角度。"""
    h = w * 0.62
    cx, cy = w / 2, h * 0.78
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
            f'width="{w}" height="{h}">'
            f'<ellipse cx="{cx}" cy="{cy}" rx="{w*0.48:.1f}" ry="{w*0.105:.1f}" fill="{RED_DK}"/>'
            f'<path d="M{cx-w*0.30:.1f} {cy} C {cx-w*0.30:.1f} {cy-h*0.72:.1f} '
            f'{cx+w*0.30:.1f} {cy-h*0.72:.1f} {cx+w*0.30:.1f} {cy} Z" fill="{RED}"/>'
            # 不加帽带：一顶纯红的圆顶礼帽在这个尺寸下更干净、也更像那张剧照
            f'</svg>')


def petal_svg(color) -> str:
    """一片花瓣/叶子。围着小丑慢慢飘的那些。"""
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="40" height="20">'
            f'<path d="M0 10 C 10 0 30 0 40 10 C 30 20 10 20 0 10 Z" fill="{color}"/></svg>')


def _body(with_arms=False, with_hat=False) -> str:
    """身体：腿、马甲、领结、头。手臂和头上那顶帽子默认不画 —— 它们要各自动。

    整个人被拆成四层，四层用**同一个 620×620 画布**：这样它们在页面上完全重合，
    定位不用算偏移，手臂的旋转中心也能直接用画布百分比表达。
    """
    p = []
    a = p.append

    # 腿。宽松裤，一条支撑一条踢起来。
    a(f'<path d="M156 356 C 146 424 142 486 148 540 L196 540 C 198 470 194 410 '
      f'196 356 Z" fill="{RED}"/>')
    a(f'<path d="M196 356 C 232 396 268 430 300 448 L282 492 C 236 470 194 428 '
      f'168 386 Z" fill="{RED}"/>')
    a(f'<ellipse cx="170" cy="552" rx="34" ry="13" fill="{VEST}"/>')
    a(f'<ellipse cx="300" cy="470" rx="33" ry="13" fill="{VEST}" transform="rotate(-32 300 470)"/>')

    # 马甲。收腰再放出去 —— 等宽的长方形看着像个盒子。
    a(f'<path d="M146 228 C 150 268 152 296 158 316 L198 316 C 204 292 206 264 '
      f'210 228 Z" fill="{VEST}"/>')
    a(f'<path d="M158 316 L198 316 L202 362 L154 362 Z" fill="{VEST}"/>')
    a(f'<path d="M178 232 L178 358" stroke="{RED_DK}" stroke-width="2.5" opacity="0.45"/>')
    for y in (276, 306):
        a(f'<circle cx="178" cy="{y}" r="3.5" fill="{BLOOM_A}"/>')

    if with_arms:
        a(_arm("L")); a(_arm("R"))

    # 白领 + 领结。这一块白是全图最亮的点。
    a(f'<path d="M150 214 L190 258 L230 214 L212 204 L190 232 L168 204 Z" fill="{PAPER}"/>')
    a(f'<path d="M190 236 l-20 -11 v22 z" fill="{BLOOM_A}"/>')
    a(f'<path d="M190 236 l20 -11 v22 z" fill="{BLOOM_A}"/>')
    a(f'<circle cx="190" cy="236" r="5" fill="{RED_DK}"/>')

    # 头
    a(f'<circle cx="190" cy="176" r="38" fill="{SKIN}"/>')
    a(f'<circle cx="179" cy="170" r="4.5" fill="{INK}"/>')
    a(f'<circle cx="202" cy="170" r="4.5" fill="{INK}"/>')
    a(f'<circle cx="191" cy="188" r="8.5" fill="{RED}"/>')

    if with_hat:
        a(bowler(190, 146, 96, tilt=-6))
    return "".join(p)


def _arm(side: str) -> str:
    """一条手臂。肩在上、手在下，手就是一个圆 ——

    不画手指：五根手指在这个尺寸下会变成一团糊，而一个圆已经足够说明"这是手"。
    而且帽子要粘在手上，圆形的接触点比一只张开的手可信 —— 想象它是块磁铁。
    """
    if side == "L":
        return (f'<g><path d="M152 244 C 122 258 100 240 86 218" stroke="{RED}" '
                f'stroke-width="20" fill="none" stroke-linecap="round"/>'
                f'<circle cx="80" cy="210" r="13" fill="{SKIN}"/></g>')
    return (f'<g><path d="M204 244 C 238 256 268 250 290 238" stroke="{RED}" '
            f'stroke-width="20" fill="none" stroke-linecap="round"/>'
            f'<circle cx="296" cy="234" r="13" fill="{SKIN}"/></g>')


# ── 首页那两个入口的图标 ──────────────────────────────────────────
#
# 老用户进来看到的是两个键：「我的」和「定歌」。图标不能是两个线框小人 ——
# 扉页上面已经有花环和星了，这两个得是同一册书里的东西。

def face_svg(mood: str = "plain") -> str:
    """「我的」：小丑的脸。

    就是等待页上那个费斯特，只把头单独裁出来 —— 用户等歌时看的是他，
    回来找自己的歌看到的还是他，这两处得是同一个人。

    mood 给了四种表情。原来只有一种、而且刻意不画嘴（一个笑脸会立刻把它
    变成儿童贴纸）。但一张永远不动的脸摆在歌单顶上是块牌子，不是个人 ——
    所以加了嘴，并且让「我的」那一页轮着换：多数时候是平的，偶尔笑一下、
    眨一下眼。不动的那一版（plain）仍然是扉页按钮用的，那儿它是标记不是角色。

    viewBox 按内容裁紧并居中：图标要塞进一个小方框，四周的空白由按钮自己的
    padding 给，画布里再留一圈就等于图缩了两次。
    """
    p = [bowler(190, 146, 96, tilt=-6),
         f'<circle cx="190" cy="176" r="38" fill="{SKIN}"/>']
    # 眼。闭着的眼是一道朝上弯的弧，不是一条横线 —— 横线是"闭眼"，弧才是"笑起来"。
    def eye_open(cx):
        return f'<circle cx="{cx}" cy="170" r="4.5" fill="{INK}"/>'
    def eye_shut(cx):
        return (f'<path d="M{cx-6} 172 Q {cx} 165 {cx+6} 172" stroke="{INK}" '
                f'stroke-width="3" fill="none" stroke-linecap="round"/>')
    if mood == "wink":
        p.append(eye_shut(179)); p.append(eye_open(202))
    elif mood == "blink":
        p.append(eye_shut(179)); p.append(eye_shut(202))
    else:
        p.append(eye_open(179)); p.append(eye_open(202))
    p.append(f'<circle cx="191" cy="188" r="8.5" fill="{RED}"/>')
    # 嘴。一牙月形，不是一条描边的弧 —— 这册书里一根描边都没有。
    if mood in ("smile", "wink"):
        p.append(f'<path d="M177 199 Q 191 210 205 199 Q 191 204.5 177 199 Z" fill="{INK}"/>')
    elif mood == "grin":
        p.append(f'<path d="M174 198 Q 191 215 208 198 Q 191 205 174 198 Z" fill="{INK}"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="126 91 128 128" '
            'width="128" height="128">' + "".join(p) + "</svg>")


def crown_svg() -> str:
    """「定歌」：一顶银冠。

    改了九版才落到这儿，失败的原因一版比一版根本，都记下来免得有人再走一遍：
      一版 金环插三朵大白花 —— 粗、硬，像个网管。
      二版 九根直杆顶着圆点 —— 成了插在针插上的一排大头针。
      三版 半圆的弧 —— 太陡，两端叶子甩成尖刺，读出来是月桂枝。
      四版 压扁的叶带 —— 好看，但冠没了，变成一顶花环。
      五版 分叉的枝 + 叶 + 四色小点 —— 形对了，但同一张图混了描边、填色、
           轮廓线三种画法和八种线宽，是幅剪贴画。
      六版 统一成一种线宽的金线画 —— 干净，可还是"图纸"。
      七版 实心锥形的枝 —— 枝像枝了，但"一个圆圈上插六根杆"仍然是光头长草。
      八版 整块剪影的冠 —— 冠是冠了，但笨重（用户原话：比汉堡王还笨重一百倍）。
      九版（现在）：**尖是外长内短、向外张开的银芒；底座换成一条两头收尖、
           中间最厚的实心弧**。椭圆环被否掉的原因就是它 —— 一个圈上插杆永远是草，
           而一条压在下面的实心弧把重量收在底下，整件事就站住了。
           芒画在底座之前，所以芒是从底座**背后**长出来的，不是插在上面。

    银不是金：银 + 白花在夜里是月光，金容易往喜庆上跑。

    野枝从骨架**前后各穿一层** —— 前后都有才叫穿过去。叶和花是按参数
    挂在藤身上的（算出藤上的点和切线再摆），不是另找地方点的；
    上一版那样点出来的叶看着像撒在图上的绿色短划。

    白花是纯白：压在纸色上几乎不显，白天读到的是一副银骨架；
    到了夜里同一批花从深色里浮出来，像星星一样亮。另外埋了六粒星尘 ——
    白天完全看不见，只在夜里存在的那一层。
    """
    SILV, SILV_H = "#9AA3AB", "#E3E9EE"     # 银，和它的高光
    PAPER_HOLE = "#F7F4ED"                  # 镂空只能填纸色：SVG 里挖不出真的洞
    VINE_C, LEAF_C = "#1E7A5F", "#4FB894"   # 藤，和藤上的细叶
    WHITE = "#FFFFFF"

    # ── 曲线工具。藤要自己蜿蜒：一段三次曲线画出来几乎是直线，
    #    几根直线交叉在一起就是一把挑棍。用 Catmull-Rom 把锚点串成多段平滑曲线，
    #    并且能在藤身上按参数取点和切线。
    def bez(s, t):
        (p0, p1, p2, p3) = s
        u = 1 - t
        return (u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1])

    def catmull(anchors, tension=0.5):
        P = [anchors[0]] + list(anchors) + [anchors[-1]]
        out = []
        for i in range(len(anchors) - 1):
            p0, p1, p2, p3 = P[i], P[i+1], P[i+2], P[i+3]
            out.append((p1,
                        (p1[0] + (p2[0]-p0[0])*tension/3, p1[1] + (p2[1]-p0[1])*tension/3),
                        (p2[0] - (p3[0]-p1[0])*tension/3, p2[1] - (p3[1]-p1[1])*tension/3),
                        p2))
        return out

    def samples(segs, per=10):
        pts = []
        for i, s in enumerate(segs):
            for k in (range(per + 1) if i == 0 else range(1, per + 1)):
                pts.append(bez(s, k / per))
        return pts

    def at(segs, t):
        pts = samples(segs)
        i = min(len(pts) - 2, max(0, int(t * (len(pts) - 1))))
        x, y = pts[i]
        return x, y, math.degrees(math.atan2(pts[i+1][1] - y, pts[i+1][0] - x))

    def ribbon(pts, ws, fill, off=0.0):
        """沿一条中心线按法线张开成带锥度的实心形。
        描边画不出锥度 —— 而锥度正是枝之所以是枝、芒之所以是芒。"""
        L, R = [], []
        for i, (x, y) in enumerate(pts):
            j, k = min(i + 1, len(pts) - 1), max(i - 1, 0)
            dx, dy = pts[j][0] - pts[k][0], pts[j][1] - pts[k][1]
            m = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / m, dx / m
            cx, cy, w = x + nx*off, y + ny*off, ws[i] / 2
            L.append(f"{cx+nx*w:.1f} {cy+ny*w:.1f}")
            R.append(f"{cx-nx*w:.1f} {cy-ny*w:.1f}")
        return (f'<path d="M{L[0]} ' + " ".join("L" + s for s in L[1:]) + " "
                + " ".join("L" + s for s in reversed(R)) + f' Z" fill="{fill}"/>')

    def vine(anchors, w0=1.9, w1=0.42):
        segs = catmull(anchors)
        pts = samples(segs)
        n = len(pts) - 1
        return ribbon(pts, [w0 + (w1-w0)*(i/n)**0.8 for i in range(n+1)], VINE_C), segs

    def ray(x0, y0, x1, y1, w0, w1):
        """一根银芒：底色一条，再压一条更窄、偏在一侧的亮色。
        平涂表示"这是金属、有光"就是这么表示的，不用渐变。"""
        p0, p3 = (x0, y0), (x1, y1)
        seg = (p0, ((x0*2+x1)/3, (y0*2+y1)/3 + 4), ((x0+x1*2)/3, (y0+y1*2)/3), p3)
        pts = samples([seg], 14)
        n = len(pts) - 1
        ws = [w0 + (w1-w0)*(i/n)**0.85 for i in range(n+1)]
        return (ribbon(pts, ws, SILV)
                + ribbon(pts, [max(0.45, w*0.32) for w in ws], SILV_H, off=-w0*0.26))

    def cross_pattee(cx, cy, L=10.0, W=5.6, w=2.4):
        """一枚十字：四臂从腰部向外**外扩**，边是内凹的（cross pattée）。

        直边的等宽十字是个加号，是医院和药店的记号；把腰收细、臂端放宽、
        中间那段边内凹一下，它才是冠上的那一枚 —— 崇高感全在这道内凹里。
        """
        P = []
        def q(x0, y0, cxp, cyp, x1, y1):
            P.append(f"Q{cxp:.1f} {cyp:.1f} {x1:.1f} {y1:.1f}")
        P.append(f"M{cx-W:.1f} {cy-L:.1f}")
        P.append(f"L{cx+W:.1f} {cy-L:.1f}")
        q(0,0, cx+w, cy-L*0.55, cx+w, cy-w)
        q(0,0, cx+L*0.55, cy-w, cx+L, cy-W)
        P.append(f"L{cx+L:.1f} {cy+W:.1f}")
        q(0,0, cx+L*0.55, cy+w, cx+w, cy+w)
        q(0,0, cx+w, cy+L*0.55, cx+W, cy+L)
        P.append(f"L{cx-W:.1f} {cy+L:.1f}")
        q(0,0, cx-w, cy+L*0.55, cx-w, cy+w)
        q(0,0, cx-L*0.55, cy+w, cx-L, cy+W)
        P.append(f"L{cx-L:.1f} {cy-W:.1f}")
        q(0,0, cx-L*0.55, cy-w, cx-w, cy-w)
        q(0,0, cx-w, cy-L*0.55, cx-W, cy-L)
        return f'<path d="{" ".join(P)} Z" fill="{SILV}"/>'

    def blossom(cx, cy, r, tilt=0.0):
        """五个**圆**瓣 —— 椭圆瓣拉出来的是雏菊，圆瓣收起来的才是梅；
        而且缩小之后它糊成的是一颗带金心的柔白点，正是这个尺寸下最好的样子。"""
        out = []
        for i in range(5):
            a = math.radians(tilt + i * 72.0)
            out.append(f'<circle cx="{cx + math.cos(a)*r*0.52:.1f}" '
                       f'cy="{cy + math.sin(a)*r*0.52:.1f}" '
                       f'r="{r*0.44:.1f}" fill="{WHITE}"/>')
        out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" '
                   f'r="{max(0.9, r*0.23):.1f}" fill="{BLOOM_A}"/>')
        return "".join(out)

    p = []
    a = p.append

    # 六根芒：长度 88/82/76，外张 24°/15°/6°。长度差很小、张角差很大 ——
    # "向外延伸"是靠**角度**做出来的，不是靠一根比一根短。
    RAYS = ((38, 100, 2.2, 16.6, 5.6, 1.2), (48, 102, 26.8, 19.8, 5.2, 1.1),
            (58, 103, 50.1, 24.4, 4.6, 1.0), (70, 103, 77.9, 24.4, 4.6, 1.0),
            (80, 102, 101.2, 19.8, 5.2, 1.1), (90, 100, 125.8, 16.6, 5.6, 1.2))
    V_BACK  = [[(8, 88), (22, 68), (16, 50), (33, 40), (52, 33), (68, 20)],
               [(97, 96), (88, 78), (100, 62), (92, 46), (78, 34)],
               # 冠的中腰原来是空的。再从背后穿一根横过去 ——
               # 走背面不走正面：正面那两根已经在下半截了，再叠一根会糊成一团。
               [(24, 80), (42, 58), (62, 50), (80, 58), (100, 42)]]
    V_FRONT = [[(116, 86), (99, 74), (105, 56), (85, 48), (64, 46), (50, 30)],
               [(14, 76), (36, 86), (60, 79), (86, 86), (112, 72)]]

    back, front = [], []
    for anchors in V_BACK:
        d, s = vine(anchors, 2.0, 0.45); a(d); back.append(s)
    for x0, y0, x1, y1, w0, w1 in RAYS:
        a(ray(x0, y0, x1, y1, w0, w1))

    # 底座：一条两头收尖、中间最厚的实心弧，宽度**只到六根芒的脚**（x 34–94），
    # 也就是那个梯形的下底。
    # 第一版从 x8 铺到 x120，比芒脚宽出一大截、两端还往上翘 —— 那两截翘出去的
    # 就是盘沿，于是整张图读成"一盘植物"。宽度收回到芒脚，弧改成向下微鼓
    # （那是环的正面在透视里的样子），盘子感就没有了。
    a(f'<path fill="{SILV}" d="M34 99 C 48 103 80 103 94 99 C 80 110 48 110 34 99 Z"/>')
    a(f'<path fill="none" stroke="{SILV_H}" stroke-width="1.1" stroke-linecap="round" '
      f'd="M40 100.2 C 52 103.4 76 103.4 88 100.2"/>')

    # 正心不镶石头。
    # 试过十字（银球 → 串珠 → 实心缠藤，三版：厚、骨感、太宗教）和一粒亮蓝的钻
    # （先是贴在冠前面，后来做成底座隆起的包镶座）。钻这条也否了 ——
    # 一粒冷色的宝石落在这顶银枝白花的冠上，抢掉了全部注意力，
    # 而这顶冠好看的地方本来是"银是硬的、花是野的"这一组关系。
    # 结论：正心留白。这是这顶冠改到第十版才学会的一件事。

    for anchors in V_FRONT:
        d, s = vine(anchors, 1.8, 0.4); a(d); front.append(s)

    for segs in back + front:
        # 原来每根五片。散落的粉点白点撤掉之后，那些位置改用叶来填 ——
        # 叶是这册书里本来就有的东西，孤零零的圆点不是。
        for t, side, ln in ((.10, -1, 8), (.16, 1, 11), (.26, -1, 9), (.33, -1, 13),
                            (.44, 1, 8), (.52, 1, 10), (.62, -1, 9), (.7, -1, 12),
                            (.79, 1, 8), (.86, 1, 9), (.94, -1, 7)):
            x, y, ang = at(segs, t)
            a(f'<path d="M0 0 C 8 -6 22 -6 30 0 C 22 6 8 6 0 0 Z" fill="{LEAF_C}" '
              f'transform="translate({x:.1f} {y:.1f}) rotate({ang + side*52:.1f}) '
              f'scale({ln/30:.3f} {ln/30*0.4:.3f})"/>')

    for segs, items in ((back[0],  ((.30, 7.6, -18), (.62, 5.2, 24), (.93, 8.2, -6))),
                        (back[1],  ((.22, 4.4, 30), (.55, 6.0, -28), (.88, 5.4, 12))),
                        (front[0], ((.14, 4.6, 8), (.44, 6.6, -34), (.78, 4.0, 20),
                                    (.97, 7.0, -12))),
                        (front[1], ((.10, 5.0, 26), (.40, 3.6, -16), (.72, 4.2, 36),
                                    (.95, 4.8, -4))),
                        (back[2],  ((.12, 4.2, 14), (.38, 5.6, -26), (.62, 3.8, 32),
                                    (.86, 5.0, -8)))):
        for t, r, tilt in items:
            x, y, _ = at(segs, t)
            a(blossom(x, y, r, tilt))
    # 原来这里散着一粒洋红、一粒藏红花和六粒白星尘。全撤了：
    # 那是"往图上再点几笔"，不是画的一部分 —— 一颗孤立的圆点在这套语言里
    # 没有身份，既不是花也不是叶。空出来的地方由上面加密的叶接管。

    # 画布两侧各留 10、顶上留 2：最外那两朵花的花瓣本来在 0–128 之外，会被切掉。
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 2 148 114" '
            'width="148" height="114">' + "".join(p) + "</svg>")


def _wrap(inner: str) -> str:
    """统一的画布。四层共用，所以它们在页面上严丝合缝地重叠。"""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
            f'width="{W}" height="{H}"><g transform="translate(120 0)">{inner}</g></svg>')


def svg() -> str:
    """完整的一张（静态场合用，比如分享封面）。"""
    return _wrap(_body(with_arms=True, with_hat=True))


def body_svg() -> str:
    return _wrap(_body())


def arm_svg(side: str) -> str:
    return _wrap(_arm(side))


def data_uri() -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg().encode()).decode()


def uri(markup: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(markup.encode()).decode()


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        print(json.dumps({
            "FESTE": uri(svg()),
            "BODY": uri(body_svg()),
            "ARM_L": uri(arm_svg("L")),
            "ARM_R": uri(arm_svg("R")),
            "HAT": uri(hat_svg()),
            "PETAL_W": uri(petal_svg(PAPER)),
            "FACE": uri(face_svg()),
            "FACE_SMILE": uri(face_svg("smile")),
            "FACE_WINK": uri(face_svg("wink")),
            "FACE_GRIN": uri(face_svg("grin")),
            "FACE_BLINK": uri(face_svg("blink")),
            "CROWN": uri(crown_svg()),
            "PETAL_A": uri(petal_svg(LEAF_A)),
            "PETAL_B": uri(petal_svg(BLOOM_A)),
        }, ensure_ascii=False))
    elif len(sys.argv) > 1 and sys.argv[1] == "--uri":
        print(data_uri())
    else:
        print(svg())
