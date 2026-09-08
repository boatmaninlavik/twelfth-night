-- 十二夜 — run once in the Supabase SQL editor.

create table if not exists twelfth_orders (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  openid         text,                       -- 小程序用户，内测期可空
  occasion       text,                       -- 求婚 / 纪念日 / 给父母 …
  to_name        text,
  from_name      text,
  story          text not null,
  ref_song       jsonb,                      -- {id,name,artist,album,albumArt}

  title          text,                       -- deepseek 产出
  lyrics         text,
  style          text,

  suno_task_id   text,
  song_url       text,                       -- Suno 原曲
  vocal_url      text,                       -- 分轨：人声
  instrumental_url text,                     -- 分轨：伴奏
  voice_path     text,                       -- 用户录音在 bucket 里的路径
  result_url     text,                       -- 换音后的成品

  -- created → writing → generating → generated → separating
  --   → awaiting_voice → converting → done | failed
  -- 词级时间戳（Modal 强制对齐的产物，见 modal/align.py）。
  -- {lines:[{index,text,start,end,confidence,words:[...]}], meanConfidence, ...}
  -- 置信度低于 0.35 时前端退回纯歌词，不显示错的同步 —— 错的同步比没有同步更糟。
  lyric_lines    jsonb,

  status         text not null default 'created',
  error          text
);

-- 已经建过表的库补这一列：
-- alter table twelfth_orders add column if not exists lyric_lines jsonb;

create index if not exists twelfth_orders_openid_idx on twelfth_orders (openid, created_at desc);
create index if not exists twelfth_orders_status_idx on twelfth_orders (status);

-- Bucket 'twelfth-night' 需在 Storage 里手动新建，设为 private。
-- 服务端用 service-role key 上传并签发临时 URL，所以不需要公开读权限。

-- 通过直连（psql / pg client）建表时，Supabase 不会自动授权给 API 角色 —— 只有在
-- SQL Editor 里执行才会。少了这段，supabase-js 会报 "permission denied for table"。
grant usage on schema public to service_role, anon, authenticated;
grant all privileges on table twelfth_orders to service_role;

-- 开 RLS 且不写任何 policy：service_role 天然绕过 RLS，而 anon / authenticated
-- 因为没有 policy 而读不到任何东西。订单里有用户讲的私事，默认就该是关着的。
alter table twelfth_orders enable row level security;

-- PostgREST 缓存表结构，新建的表要通知它重新读一次，否则仍然 404 / 权限错。
notify pgrst, 'reload schema';
