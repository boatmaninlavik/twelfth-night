/**
 * 声音卡：这首歌听起来是什么样。
 *
 * 要解决的是「开盲盒」——用户下完单完全不知道会拿回什么类型的歌。
 *
 * 但**不能做成一张参数表**。三个下拉框（曲风/节奏/编制）看着专业，实际上
 * 把门槛抬高了：绝大多数人不知道自己要 lo-fi 还是 city pop、不知道 90 BPM
 * 是快是慢。order.js 开头那句教训在这儿同样成立 ——
 * 「人一进来看到的是一张表，不是一件事」。
 *
 * 所以用和提词卡（utils/cues.js）完全相同的手法：**不问参数，问听感**。
 * 每张卡一句人话 + 一句补充，背后挂着给音乐模型的英文声音描述，用户看不见。
 *
 * 为什么没有单独的「节奏」一问：
 * 速度已经长在五张卡里了（房间里的吉他必然慢，有鼓往前走必然快）。
 * 再加一排「慢一点／快一点」就是把刚刚赶走的参数表从后门放回来，
 * 而且它和卡片自带的 BPM 会互相打架。一问，五个答案，点哪张走哪张。
 *
 * sound 字段的写法照 lyrics.js 的规矩：**纯声音描述，一个名字都不许出现**。
 * 名字进了 style，Suno 会以 SENSITIVE_WORD_ERROR 整单拒掉 ——
 * 那不是效果差一点，是这一单直接做不出来。
 */

const TUNES = [
  {
    k: 'room',
    t: '一把吉他，在房间里唱的',
    eg: '很近，安静，几乎听得见换气',
    sound: 'solo acoustic guitar, fingerpicked, close-miked intimate room sound, '
         + 'no drums, soft breathy vocal, warm and quiet, 65-80 BPM',
  },
  {
    k: 'piano',
    t: '钢琴，慢，像写给一个人听',
    eg: '克制，留白多，后半段才重起来',
    sound: 'solo piano ballad, sparse arrangement, lots of space between phrases, '
         + 'restrained vocal, gradual build in the second half, minor-leaning, 60-75 BPM',
  },
  {
    k: 'band',
    t: '有鼓，往前走',
    eg: '明亮，有劲，适合放在车里听',
    sound: 'full band, acoustic guitar and drums, steady driving rhythm, '
         + 'bright major key, confident open vocal, uplifting, 100-120 BPM',
  },
  {
    k: 'strings',
    t: '弦乐进来，会哭的那种',
    eg: '开头很轻，到后面一层层推上去',
    sound: 'cinematic ballad, piano intro, strings entering mid-song, '
         + 'swelling orchestral build, emotive vocal with dynamic range, 70-85 BPM',
  },
  {
    k: 'light',
    t: '轻快，带一点玩笑',
    eg: '不用力，像随口哼出来的',
    sound: 'light playful folk-pop, ukulele or muted acoustic guitar, '
         + 'gentle shuffle groove, easy hummed vocal, cheerful and unforced, 105-125 BPM',
  },
];

/** 跟着参考歌走。有参考歌时这张排在最前面并默认选中 —— 参考歌是比任何卡片
 *  都强的信号，不该让人回答两遍同一个问题。 */
const REF = { k: 'ref', t: '', eg: '按你选的那首歌的调子来', sound: '' };

/** 不指定。跟定歌页「不指定」是同一个立场：留白是允许的，不是遗漏。 */
const FREE = { k: 'free', t: '不指定，让它自己长', sound: '' };

/** 有参考歌就把 ref 那张拼在最前面，并把歌名填进去。 */
function deck(refSong) {
  if (!refSong || !refSong.name) return TUNES;
  return [{ ...REF, t: `跟着《${refSong.name}》的调子` }, ...TUNES];
}

/** 按 key 取那段英文声音描述。ref 和 free 都返回空 —— 交给 lyrics.js 原来那套。 */
function sound(k) {
  const t = TUNES.find((x) => x.k === k);
  return t ? t.sound : '';
}

module.exports = { TUNES, FREE, deck, sound };
