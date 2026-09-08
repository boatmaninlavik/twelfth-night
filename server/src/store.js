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

/** Upload a buffer and return a signed URL valid for a week. */
export async function putAudio(path, buffer, contentType = 'audio/mpeg') {
  const { error } = await db.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`putAudio: ${error.message}`);
  const { data, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
  if (signErr) throw new Error(`sign: ${signErr.message}`);
  return data.signedUrl;
}
