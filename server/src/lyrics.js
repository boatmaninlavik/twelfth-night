/**
 * 故事进来，歌词 + 一段编曲描述出去。
 *
 * 用 Gemini 而不是 DeepSeek：DeepSeek 短、快、便宜，但中文创意写作偏弱 ——
 * 出来的词工整、正确、没有一句是记得住的。这一步是整条链里唯一决定"这首歌
 * 是不是那个人"的地方，省不得。DEEPSEEK_API_KEY 留在 .env 里当兜底。
 *
 * 参考歌曲怎么用 —— 这一条我先前**做反了**，照 erised-web 的做法改回来。
 *
 * 反的做法（旧）：让模型自由写一段编曲描述，再把「inspired by: 晴天 by 周杰伦」
 * 拼在最后一句。两个问题：
 *   1. 模型从来没被要求去**描述那首歌的声音**，于是它照着故事的情绪自由发挥。
 *      用户选了《晴天》，拿回来的是 "warm acoustic R&B, lo-fi electric piano,
 *      late night jazz bar vibe" —— 跟《晴天》没有一点关系。
 *   2. 歌名和歌手名写进 style 会被 Suno 的内容过滤挡掉
 *      （SENSITIVE_WORD_ERROR「your tags contain artist name」）。
 *      erised-web 的 SUNO_INTEGRATION.md §3.4 和 §6 就是踩了这个坑之后写的，
 *      它的 musicPrompt 是**绝不出现名字**的纯声音描述。
 *
 * 对的做法（现在）：参考歌只给模型看、当理解用，模型的任务是把
 * **那首歌听起来是什么样**翻译成纯声音描述 —— 曲风、速度、乐器、制作质感、
 * 旋律性格、人声唱法、整体情绪 —— 一个名字都不许出现。
 * 这段描述本身就是给 Suno 的 style，不再往后面拼任何东西。
 */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 有参考歌时 style 的写法。照抄 erised-web `buildSunoLLMPrompt()` 的那条规则：
 * 模型的任务是把参考歌**听起来的样子**翻译成纯声音描述，而且一个名字都不许出现。
 */
const STYLE_WITH_REF = `
你的任务是：把上面那首参考歌**听起来是什么样**，翻译成一段纯粹的声音描述。
要具体写到这几项：曲风、速度（给 BPM 区间）、主要乐器、制作质感（混响/压缩/空间感）、
旋律性格（大调还是小调、走向是上行还是下行）、人声唱法（气声、真假声、力度）、整体情绪。
**绝对不能出现任何歌名、歌手名、乐队名**，也不能写 "in the style of ..."。
音乐模型会因为 tag 里有艺人名而整单拒绝生成 —— 这不是效果问题，是做不出来。
只描述声音本身。`;

const STYLE_NO_REF = `
写一段纯粹的声音描述：曲风、速度、乐器、制作质感、人声唱法、情绪。
不要出现任何歌名和艺人名。`;

const OCCASION_HINT = {
  婚礼: '真挚、克制、不煽情，落点在"决定"而不是"浪漫"',
  告白: '心跳感，具体到某一刻，不要总结陈词',
  给亲人: '朴素、日常、不喊口号，写细节而不是感谢',
  倾诉: '把话说出来就好，不劝解、不升华，允许它没有结论',
  生日: '轻快，带一点玩笑感，不用力',
  道歉: '低姿态，承认具体的事，不辩解',
  感恩: '不说「谢谢」，说那件他为你做过的具体的事',
};

/**
 * 兜底的清洗：万一模型还是把名字写进了 style，就地抹掉。
 *
 * 名字一旦进了 style，Suno 会以 SENSITIVE_WORD_ERROR 整单拒掉 ——
 * 那不是"效果差一点"，是这一单直接做不出来。所以不能只靠 prompt 里那句禁令。
 */
function stripNames(style, refSong) {
  let out = String(style || '').trim();
  for (const n of [refSong?.name, refSong?.artist]) {
    if (!n) continue;
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'gi'), '');
  }
  // 抹掉名字之后常留下 "in the style of ,," 这类残句
  out = out.replace(/\b(in the style of|inspired by|reminiscent of|à la)\b[\s,]*/gi, '')
           .replace(/\s*,\s*,+/g, ', ')
           .replace(/^[\s,.]+|[\s,]+$/g, '')
           .replace(/\s{2,}/g, ' ');
  return out || 'warm acoustic ballad, soft vocal, intimate';
}

/**
 * 返回 { title, lyrics, style }。
 *
 * lyrics 用 Suno 的段落标记（[Verse] / [Chorus]）—— customMode 下 prompt 字段
 * 是逐字唱出来的，任何不是歌词的东西都会被唱进去。
 */
export async function writeLyrics({ story, occasion, toName, fromName, refSong }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

  // 参考歌只给模型看。下面 style 的要求里会让它把这首歌**听起来的样子**
  // 翻译成纯声音描述，而且明令不许出现名字。
  const ref = refSong?.name
    ? `参考歌曲（只给你理解用，**绝不能出现在输出里**）：`
      + `《${refSong.name}》${refSong.artist ? ` — ${refSong.artist}` : ''}\n`
    : '';
  const hint = OCCASION_HINT[occasion] || '温暖、具体、不煽情';

  const prompt = `你在为一个人写一首送给另一个人的定制歌。写得好不好，决定这首歌是被听一次还是被留着。

场合：${occasion || '未指定'}
送给：${toName || '对方'}
来自：${fromName || '我'}
${ref}

他讲的故事：
${story}

要求：
- 中文歌词。**必须用故事里的具体细节** —— 具体的物、具体的时间、具体的动作。
  写"我爱你""好想你""你是我的光"这类句子等于没写。
- ${hint}
- 结构：[Verse] / [Chorus] / [Verse] / [Chorus] / [Bridge] / [Chorus]
- lyrics 是数组，**一行歌词一个元素**；[Verse] 这类段落标记也各占一个元素
- 每段 4 行左右，总长 40 行以内
- 副歌要能被记住，可以重复；最好有一个从故事里长出来的意象贯穿全曲
- 不要解释，不要写注释，输出里除了歌词标记和歌词本身不要有别的字

style 字段是给音乐模型看的英文声音描述。${refSong?.name ? STYLE_WITH_REF : STYLE_NO_REF}`;

  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 1.1,
        // 结构化输出：比"只输出 JSON，不要任何其他文字"这种祈使句可靠得多，
        // 模型再啰嗦也不会在 JSON 外面裹一层 ```json。
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '歌名，4 字以内' },
            // 歌词要数组不要字符串。要字符串的话模型会把整首写成一行、用空格断句，
            // 中文歌词里空格本来就只出现在断行处，结果就是作品页上糊成一整片，
            // 而且 Suno 的 prompt 是逐字唱的，没有换行连乐句都断不对。
            // 数组由 responseSchema 保证形状，换行我们自己拼，没有歧义。
            lyrics: {
              type: 'array',
              description: '歌词，一行一个元素。[Verse] / [Chorus] 这类段落标记单独成行',
              items: { type: 'string' },
            },
            style: { type: 'string', description: '英文编曲描述' },
          },
          required: ['title', 'lyrics', 'style'],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json();
  const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!raw) {
    // 被安全策略挡下时 candidates 是空的，finishReason 里才有原因
    const why = body.candidates?.[0]?.finishReason || body.promptFeedback?.blockReason || '未知';
    throw new Error(`gemini 没返回内容（${why}）`);
  }

  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new Error(`gemini 返回的不是 JSON: ${raw.slice(0, 300)}`);
  }
  const lines = Array.isArray(out.lyrics)
    ? out.lyrics
    : String(out.lyrics || '').split(/\r?\n/);          // 万一模型还是给了字符串
  const lyrics = lines.map((l) => String(l).trim()).filter(Boolean).join('\n');
  if (!lyrics) throw new Error('gemini 没返回歌词');

  return {
    title: out.title || '无题',
    lyrics,
    style: stripNames(out.style || 'warm acoustic ballad, soft vocal, intimate', refSong),
  };
}
