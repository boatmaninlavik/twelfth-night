"""中文歌词的词级（这里是字级）强制对齐。

为什么不能直接用 erised-web 那份：它的 ASR 是 WAV2VEC2_ASR_BASE_960H，
字符表只有 A-Z，而 parse_lyrics 里 `NON_VOCAB = [^A-Z']` 会把中文整段清空 ——
结构上就对不了中文，报的是 "no alignable words in lyrics"。

这里换成 torchaudio 的 **MMS_FA**：Meta 的多语言强制对齐模型，词表是罗马字母，
配一个罗马化器就能对上百种语言。中文的罗马化就是拼音（去声调）。

对齐单位取「字」而不是「词」：中文歌词本来就是按字唱的，卡拉OK 也是逐字走，
而且省掉了分词这一层不确定性。

Demucs 分人声那步照抄 erised-web —— 那步跟语言无关，而且它的作用很实在：
直接拿混音去对，伴奏会被当成语音抢走对齐点。
"""
import re, sys, time
from dataclasses import dataclass
from pathlib import Path

import torch
import torchaudio
from torchaudio.pipelines import HDEMUCS_HIGH_MUSDB_PLUS as DEMUCS
from torchaudio.pipelines import MMS_FA as FA

SECTION_TAG = re.compile(r"^\s*[\[(].*?[\])]\s*$")
HAN = re.compile(r"[一-鿿]")

_MODELS = {}


def log(m):
    print(f"[align] {m}", file=sys.stderr, flush=True)


def pick_device():
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _get(key, make):
    if key not in _MODELS:
        _MODELS[key] = make()
    return _MODELS[key]


def warm(device):
    _get(f"demucs:{device}", lambda: DEMUCS.get_model().to(device).eval())
    _get(f"fa:{device}", lambda: FA.get_model().to(device).eval())


@dataclass
class Unit:
    text: str      # 原字，用来显示
    roman: str     # 拼音，用来对齐
    line: int


def romanize(ch: str) -> str:
    """一个汉字 → 去声调的拼音；非汉字按小写字母原样保留。"""
    from pypinyin import lazy_pinyin
    if HAN.match(ch):
        p = lazy_pinyin(ch)
        return re.sub(r"[^a-z]", "", p[0].lower()) if p else ""
    return re.sub(r"[^a-z]", "", ch.lower())


def parse(raw: str):
    """歌词 → (显示用的行, 对齐用的字单元)。

    [Verse] 这类段落标记整行丢掉：它们不会被唱出来，留着对齐器会去音频里找它们，
    然后把后面每一行都拖偏。
    """
    lines, units = [], []
    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line or SECTION_TAG.match(line):
            continue
        idx = len(lines)
        kept = False
        for ch in line:
            if ch.isspace():
                continue
            r = romanize(ch)
            if r:
                units.append(Unit(text=ch, roman=r, line=idx))
                kept = True
        if kept:
            lines.append(line)
    return lines, units


def load_audio(src: str, workdir: Path):
    """解码成 Demucs 要的采样率。torchaudio 新版不带解码器，外部 ffmpeg 转。"""
    import subprocess, urllib.request, shutil
    dest = workdir / "source.wav"
    raw = workdir / "source.dl"
    if src.startswith("http"):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(raw, "wb") as f:
            shutil.copyfileobj(r, f)
    else:
        shutil.copy(src, raw)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw),
                    "-ar", str(DEMUCS.sample_rate), "-ac", "2", str(dest)], check=True)
    w, sr = torchaudio.load(str(dest))
    return w, sr


def isolate_vocals(waveform, sr, device):
    """Demucs 抽人声。分段处理，整首一次进显存会炸。"""
    model = _get(f"demucs:{device}", lambda: DEMUCS.get_model().to(device).eval())
    src_idx = model.sources.index("vocals")
    chunk = int(sr * 30.0)
    out = []
    with torch.inference_mode():
        for start in range(0, waveform.shape[1], chunk):
            seg = waveform[:, start:start + chunk].to(device)
            ref = seg.mean(0)
            seg = (seg - ref.mean()) / (ref.std() + 1e-8)
            est = model(seg[None])[0]
            out.append((est[src_idx] * ref.std() + ref.mean()).cpu())
    return torch.cat(out, dim=1)


def align_song(audio: str, lyrics: str, workdir: Path, device=None) -> dict:
    device = device or pick_device()
    t0 = time.time()

    lines, units = parse(lyrics)
    if not units:
        raise ValueError("歌词里没有可对齐的字")
    log(f"{len(lines)} 行 / {len(units)} 字")

    waveform, sr = load_audio(audio, workdir)
    duration = waveform.shape[1] / sr
    vocals = isolate_vocals(waveform, sr, device)

    # 重采样到 MMS_FA 的采样率，取单声道
    v = torchaudio.functional.resample(vocals.mean(0, keepdim=True),
                                       DEMUCS.sample_rate, FA.sample_rate)
    model = _get(f"fa:{device}", lambda: FA.get_model().to(device).eval())
    with torch.inference_mode():
        emission, _ = model(v.to(device))

    D = FA.get_dict()
    # 词表外的字母（拼音里不会出现，但保险）直接丢，否则 forced_align 会抛
    toks, keep = [], []
    for i, u in enumerate(units):
        t = [D[c] for c in u.roman if c in D]
        if t:
            toks.append(t)
            keep.append(i)
    if not toks:
        raise ValueError("罗马化之后没有任何字落在模型词表里")
    units = [units[i] for i in keep]

    flat = torch.tensor([[t for tok in toks for t in tok]], device=device)
    aligned, scores = torchaudio.functional.forced_align(emission, flat, blank=0)
    spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())

    # 把 token 级的跨度按每个字的 token 数切回字级
    sec = duration / emission.shape[1]
    per_unit, k = [], 0
    for tok in toks:
        grp = spans[k:k + len(tok)]
        k += len(tok)
        if not grp:
            per_unit.append(None); continue
        per_unit.append((grp[0].start * sec, grp[-1].end * sec,
                         sum(float(s.score) for s in grp) / len(grp)))

    out_lines = [{"index": i, "text": t, "start": None, "end": None,
                  "confidence": 0.0, "words": []} for i, t in enumerate(lines)]
    for u, span in zip(units, per_unit):
        if span is None:
            continue
        st, en, cf = span
        L = out_lines[u.line]
        L["words"].append({"text": u.text, "start": round(st, 3),
                           "end": round(en, 3), "confidence": round(cf, 4)})
    scored = []
    for L in out_lines:
        if not L["words"]:
            continue
        L["start"] = L["words"][0]["start"]
        L["end"] = L["words"][-1]["end"]
        L["confidence"] = round(sum(w["confidence"] for w in L["words"]) / len(L["words"]), 4)
        scored.append(L)

    return {
        "durationSec": round(duration, 2),
        "linesTotal": len(lines),
        "linesAligned": len(scored),
        "meanConfidence": round(sum(l["confidence"] for l in scored) / len(scored), 4) if scored else 0.0,
        "elapsedSec": round(time.time() - t0, 1),
        "lines": out_lines,
    }
