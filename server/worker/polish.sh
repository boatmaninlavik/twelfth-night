#!/bin/bash
# 精修链。以 erised-artist/svc/swap_v2.sh 为准，只有三处**有意**的偏离，
# 每一处都在下面注明原因。改这个文件前先跟 swap_v2.sh 对一遍，别让两边悄悄漂开。
#
#   偏离 1  第 2 道 vocal_support 的 --max-lift-db 从 8 降到 3、--max-cut-db 从 18 提到 30
#   偏离 2  BAL 不覆盖，用 swap_v2.sh 的默认 0.0（试过按原唱算，人声反而更突出）
#
# 这就是用户实听选定的那一版（内部代号 B）：电音明显改善、音色纯粹、像本人。
# 之后加的两道自研环节都被实听否掉了，原因见下面。
set -euo pipefail
R="${ERISED_ARTIST:-$HOME/Desktop/erised-artist}"
PY="${POLISH_PY:-$R/.venv-master/bin/python}"   # 容器里用系统 python
HERE="$(cd "$(dirname "$0")" && pwd)"

LEAD="$1"; BACKVOX="$2"; INSTR="$3"; USERREF="$4"; OUT="$5"
: "${LEAD_SRC:?set LEAD_SRC=歌自己的人声轨}"
W="${WORK:-$(mktemp -d)}"; mkdir -p "$W"
step () { echo ""; echo ">>> $*"; }

step "1  遮掉模型在空隙里编的东西"
# 55 dB 而不是默认的 26：呼吸声在 -43 ~ -75 dB，闸太紧会把呼吸全删光，
# 而一个从不换气的人声一听就是假的。
$PY "$R/svc/mask_hallucination.py" --source-stem "$LEAD_SRC" --converted "$LEAD" \
    --out "$W/lead_masked.wav" --below-db 55

step "2  跟随原唱的静默 + 对齐整体电平"
# 偏离 1：lift 8→3，cut 18→30。
# 原因：模型在乐句尾巴编出来的是"有调"的声音，会被判成 voiced，于是不走"往下压"
# 而是被当成"唱得弱"往上抬 8 dB —— 电音被放大，同时所有弱帧被顶到同一条地板上，
# 起伏被压平。实测用户听感：电音明显改善。
# 原作者警告过 lift 不能往上调（12 dB 试过，把一个词抬破了），没说不能往下调。
$PY "$R/svc/vocal_support.py" --vocal "$W/lead_masked.wav" --source "$LEAD_SRC" \
    --out "$W/lead_sup.wav" --max-lift-db 3 --max-cut-db 30

# 这里曾经有两道自研的环节，都撤了，原因记在下面 —— 别再加回来，除非先解决它们的问题。
#
#   sustain.py（长句撑住）用户实听「几乎没区别」。实测也印证：乐句内衰减
#     B −2.48 dB、加了之后 −2.16 dB，而原唱是 −1.34。推力上限从 6 提到 10
#     没有变化（中位推力两版都是 +2.0 dB），说明缺口本来就不大。**增益改变不了
#     频谱形状**，而"虚"是频谱问题不是音量问题 —— 用户的原话：
#     「你唱歌气息如果很虚你把那个地方声音调大声音仍然听上去是虚的」。
#
#   tone.py（音色平衡）方向是对的（我们的人声 65% 能量堆在基频，原唱只有 30%），
#     但**实现有问题**：STFT 里直接对频谱乘一条增益曲线 = 与该曲线的冲激响应做
#     循环卷积，而那条冲激响应比帧长还长，会绕回来造成时域混叠 —— 听感就是
#     金属味的电音。用户实听：只减不加的版本音质**仍然**比 B 差，
#     而只减不加不该放大任何伪影 —— 这就证明问题在实现不在方向。
#     修法是把曲线做成加窗的线性相位 FIR 再卷积，而不是逐帧乘频谱。
#     修好并且实听通过之前，不要放回链子里。

step "3  对齐录音棚的频段平衡"
$PY "$R/svc/studio_match.py" --vocal "$W/lead_sup.wav" --original "$LEAD_SRC" --out "$W/lead_std.wav"
step "4  把空气感还原到用户自己的水平"
# 注意是"用户自己的水平"，不是录音棚的。向原唱借频谱会被听出来"不是我的声音"，
# 原作者试过三次都被否了。
$PY "$R/svc/restore_air.py" --vocal "$W/lead_std.wav" --user-ref "$USERREF" --out "$W/lead_air.wav"
step "5  把呼吸压下去，但不要删掉"
$PY "$R/svc/debreath.py" --input "$W/lead_air.wav" --out "$W/lead_db.wav" --reduce 12.0
step "6  对齐房间感 —— 必须在压呼吸之后"
# 顺序反了会把呼吸抹糊，debreath 就找不到它们了，被否决过的重呼吸会原样回来。
$PY "$R/svc/match_space_bands.py" --vocal "$W/lead_db.wav" --original "$LEAD_SRC" \
    --out "$W/lead_fin.wav"
step "7  和声原样透传"
cp "$BACKVOX" "$W/bv_fin.wav"
step "8  身份门"
$PY "$R/svc/voice_gate.py" --render "$W/lead_fin.wav" --user-ref "$USERREF" --original "$LEAD_SRC"

$PY - "$INSTR" "$W/bv_fin.wav" "$W/backing.wav" <<'PYX'
import sys, numpy as np, soundfile as sf
inst,sr=sf.read(sys.argv[1],always_2d=True)
bv,_=sf.read(sys.argv[2],always_2d=True)
if bv.ndim==1: bv=bv[:,None]
# 把和声垫到伴奏的长度，**绝不**把伴奏截到和声的长度。
# 用 min() 曾经毁掉整首歌：没有独立和声轨时调用方传 1 秒静音，n 就成了 1 秒，
# 成品是人声配一秒音乐。而且不报错，只有看频谱才发现。
n=len(inst)
if len(bv)<n: bv=np.pad(bv,((0,n-len(bv)),(0,0)))
mix=inst+np.repeat(bv[:n],inst.shape[1],axis=1)
pk=float(np.abs(mix).max())
if pk>1.0: mix=mix/pk*0.99
sf.write(sys.argv[3],mix.astype("float32"),sr)
PYX

step "9  响度闭环 —— 把人声/伴奏比拉到目标线上"
# 这是整条链里唯一一处**逐曲自适应**的地方，也是唯一该自适应的地方。
#
# 为什么要它：finish_v2 里的 auto_vocal.balance_gain 是
#     clip(目标 − 它自己实测的差, −6, +12)，而我们传 BAL=0.0。
# 伴奏稀的歌（后知后觉）落在中间，出来正好；伴奏密的歌（不如沉醉）实测差更大，
# 式子**撞在 −6 的下限上**，人声被按最大幅度压下去 —— 实测比前者低 5.5 dB。
# 交付响度于是随伴奏密度漂移，而不是落在一条线上。
#
# 给每首歌各配一个 BAL 是治不好的，那只是把漂移搬到人工上。
# 这里在混音**之前**量一次这首歌自己的人声/伴奏比，跟目标比，差多少补多少：
# 伴奏密不密都一样，因为量的就是它自己的比值。
#
# TARGET 默认 +2.46 dB，是从用户认可的那一版（后知后觉 config B）
# 用同一个度量量出来的，不是拍的。要改交付风格改这一个数，别再动 BAL。
# 只在**有人在唱**的帧上量 —— 整首平均会让间奏长的歌被补得越响。
TARGET="${VOCAL_TARGET_DB:-2.46}"
$PY "$HERE/balance.py" --vocal "$W/lead_fin.wav" --backing "$W/backing.wav" \
    --target "$TARGET" --apply "$W/lead_bal.wav" || cp "$W/lead_fin.wav" "$W/lead_bal.wav"
[ -f "$W/lead_bal.wav" ] || cp "$W/lead_fin.wav" "$W/lead_bal.wav"

step "10 母带"
# 偏离 3：不设 BAL。试过按原唱实测值传（这首歌 +6.7），人声反而比原版突出 +4.2 dB
# 而不是 +1.8 —— auto_vocal 的增益是在我们的人声上算的，目标值不能直接填原唱的数。
# 现在响度由上面那一步的闭环负责，BAL 更没有理由动。
BACKING="$W/backing.wav" PERF="$LEAD_SRC" LUFS="${LUFS:--9}" \
  bash "$R/svc/finish_v2.sh" "$W/lead_bal.wav" "$OUT"
cp "$W/lead_bal.wav" "${OUT%.wav}-VOCAL-ONLY.wav"

# 交付前复量一次，把数字打进日志：出问题时这一行就是证据，不用再去猜。
$PY "$HERE/balance.py" --vocal "$W/lead_bal.wav" --backing "$W/backing.wav" \
    --target "$TARGET" || true
echo ""; echo "done -> $OUT"
