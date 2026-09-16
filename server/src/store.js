/**
 * Supabase: one table for orders, one bucket for audio.
 *
 * The service-role key is used because this is a server talking to its own database;
 * it bypasses RLS, so it must never reach the mini program.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

export const BUCKET = process.env.SUPABASE_BUCKET || 'twelfth-night';
export const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const TABLE = 'twelfth_orders';

export async function createOrder(fields) {
  const { data, error } = await db.from(TABLE).insert(fields).select().single();
  if (error) throw new Error(`createOrder: ${error.message}`);
  return data;
}

export async function updateOrder(id, patch) {
  const { data, error } = await db.from(TABLE).update(patch).eq('id', id).select().single();
  if (error) throw new Error(`updateOrder: ${error.message}`);
  return data;
}

export async function getOrder(id) {
  const { data, error } = await db.from(TABLE).select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

/**
 * A batch read for the 「我的」 list.
 *
 * Takes explicit ids because the mini program keeps its own index of what this device
 * ordered: openid is the server's idea of identity, but code2Session fails on the test
 * account, so a list keyed only on openid would come back empty for most testers.
 * openid is still honoured when present — that is the path that survives a reinstall.
 */
export async function listOrders({ ids, openid, limit = 60 }) {
  let q = db.from(TABLE).select('*').order('created_at', { ascending: false }).limit(limit);
  if (ids && ids.length) q = q.in('id', ids);
  else if (openid) q = q.eq('openid', openid);
  else return [];
  const { data, error } = await q;
  if (error) throw new Error(`listOrders: ${error.message}`);
  return data || [];
}

/* ── 声音档案 ──────────────────────────────────────────
   录音挂在人身上不挂在单上：一份档案 12 个月有效，期间下的单都用它。
   openid 优先、设备令牌兜底 —— 跟 listOrders 同一个路数，理由也一样
   （code2Session 在测试号上常失败，openid 拿不稳）。 */

const VOICES = 'twelfth_voices';

/** 12 个月。跟小程序 utils/voice.js 的 MONTHS 和授权书 3.1 必须是同一个数。 */
export const VOICE_MONTHS = 12;

/**
 * PostgREST 的 or() 收的是一段**用逗号和点分隔的过滤表达式**，不是参数化的值。
 * 把用户送来的字符串直接拼进去，等于让对方能改写这条查询的过滤条件 ——
 * 而这张表里存的是声音。openid 和我们自己发的令牌都只含字母数字和 -_，
 * 所以就地削掉其余字符：合法值一个都不受影响，构造出来的值直接失效。
 */
const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);

function voiceMatch(q, { openid, token }) {
  // 两个都有就用 or：换过设备的人靠 openid 找回，拿不到 openid 的靠令牌。
  if (openid && token) return q.or(`openid.eq.${safeId(openid)},device_token.eq.${safeId(token)}`);
  if (openid) return q.eq('openid', openid);      // eq() 是参数化的，不用削
  return q.eq('device_token', token);
}

/** 当前有效的那一份。过期和已撤回的都不算 —— 宁可让人重录，不可超期使用。 */
export async function getVoiceProfile({ openid, token }) {
  if (!openid && !token) return null;
  let q = db.from(VOICES).select('*')
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('updated_at', { ascending: false })
    .limit(1);
  const { data, error } = await voiceMatch(q, { openid, token });
  if (error) throw new Error(`getVoiceProfile: ${error.message}`);
  return (data && data[0]) || null;
}

/**
 * 建档或换档。
 *
 * 重录是**换掉**不是再加一份：加一份等于 bucket 里留了两份声音，
 * 而用户以为自己只有一份 —— 撤回时就删不干净。
 * 所以先把旧的那份连文件一起清掉，再写新的。
 */
export async function putVoiceProfile({ openid, token, voicePath, durationSec, audioMd5, consent }) {
  const old = await getVoiceProfile({ openid, token });
  if (old) await dropVoiceProfile(old, { hard: true });

  const expires = new Date();
  expires.setMonth(expires.getMonth() + VOICE_MONTHS);

  const { data, error } = await db.from(VOICES).insert({
    openid: openid || null,
    device_token: token || null,
    voice_path: voicePath,
    duration_sec: durationSec || null,
    audio_md5: audioMd5 || null,
    consent: consent || null,
    expires_at: expires.toISOString(),
  }).select().single();
  if (error) throw new Error(`putVoiceProfile: ${error.message}`);
  return data;
}

/**
 * 撤回一份档案：删 bucket 里的文件，行留着打个撤回戳。
 *
 * 不物理删行是故意的：那一行里没有声纹数据本身（voice_path 会置空），
 * 但它是"我们确实按时履行了删除义务"的记录。监管来问的时候要拿得出来。
 * hard 为真时（换档）连行一起删——那不是撤回，是替换。
 */
export async function dropVoiceProfile(row, { hard = false } = {}) {
  if (row.voice_path) {
    const { error } = await db.storage.from(BUCKET).remove([row.voice_path]);
    // 文件本来就不在了也算删成功：用户要的结果已经达成
    if (error && !/not found/i.test(error.message)) {
      throw new Error(`删除录音文件失败: ${error.message}`);
    }
  }
  if (hard) {
    await db.from(VOICES).delete().eq('id', row.id);
    return;
  }
  await db.from(VOICES).update({
    voice_path: '',
    revoked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);
}

/** Upload a buffer and return a signed URL valid for a week. */
export async function putAudio(path, buffer, contentType = 'audio/mpeg') {
  const { error } = await db.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`putAudio: ${error.message}`);
  const { data, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
  if (signErr) throw new Error(`sign: ${signErr.message}`);
  return data.signedUrl;
}
