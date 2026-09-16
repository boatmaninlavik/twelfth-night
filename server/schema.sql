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
  tune           jsonb,                      -- 定调页选的声音卡 {key,sound}

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

  -- 用不用用户自己的声音。第一层授权被拒时是 false —— 那种单不等录音，
  -- 直接交付原版，否则订单会永远停在 awaiting_voice，用户看到的是一首
  -- 永远做不完的歌。
  use_own_voice  boolean not null default true,

  -- 声音授权的存证。授权书本身不重要，**能证明"这个人在这个时间确实同意了"
  -- 才重要**。里头是两层同意各一条：条款版本号、签署时间、勾选动作、
  -- 展示时长、是否滚动到底、设备信息、录音的 md5 和当时的提示语。
  -- 条款改版后旧单仍能靠 version 还原当时用户看到的是哪一版。
  consent        jsonb,

  status         text not null default 'created',
  error          text
);

-- 已经建过表的库补这几列：
-- alter table twelfth_orders add column if not exists lyric_lines jsonb;
-- alter table twelfth_orders add column if not exists use_own_voice boolean not null default true;
-- alter table twelfth_orders add column if not exists consent jsonb;
-- alter table twelfth_orders add column if not exists tune jsonb;

create index if not exists twelfth_orders_openid_idx on twelfth_orders (openid, created_at desc);
create index if not exists twelfth_orders_status_idx on twelfth_orders (status);


-- 声音档案。
--
-- 录音挂在**人**身上，不挂在**单**上。原来每做一首都要重录一遍，第二次下单的人
-- 立刻会发现这件事很蠢；更糟的是同一个人的声音会散在 N 个订单里，撤回时删不干净。
--
-- 一个人一份档案，12 个月有效，期间下的单都用它。这个 12 跟小程序端
-- utils/voice.js 的 MONTHS、以及授权书 3.1 写的必须是同一个数。
create table if not exists twelfth_voices (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 服务端认 openid，但这个 app 拿不稳（code2Session 在测试号上常失败），
  -- 所以同时收一个设备令牌当退路 —— 跟小程序自己记订单索引是同一个思路。
  -- ⚠️ 令牌的安全性远不如 openid：拿到令牌等于拿到那份录音的使用权。
  --    正式上线、code2Session 稳定之后应该收紧成只认 openid。
  openid       text,
  device_token text,

  voice_path   text not null,             -- bucket 里的路径
  duration_sec int,
  audio_md5    text,                      -- 证明后续用的样本和签署时那一份是同一个

  consent      jsonb,                     -- 建档时那一份存证
  expires_at   timestamptz not null,      -- 建档 + 12 个月，到期主动删
  revoked_at   timestamptz                -- 撤回时打戳，不物理删行（要留履约记录）
);

-- 一个人同时只有一份有效档案。重录是**换掉**，不是再加一份 ——
-- 加一份就等于 bucket 里留了两份声音，而用户以为自己只有一份。
create unique index if not exists twelfth_voices_openid_live
  on twelfth_voices (openid) where openid is not null and revoked_at is null;
create unique index if not exists twelfth_voices_token_live
  on twelfth_voices (device_token) where device_token is not null and revoked_at is null;

grant all privileges on table twelfth_voices to service_role;
alter table twelfth_voices enable row level security;

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
