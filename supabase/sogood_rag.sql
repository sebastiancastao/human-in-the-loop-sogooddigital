-- Run this in Supabase SQL editor if you don't have the table yet.
-- WARNING: The RLS policies below allow anonymous read/write. Tighten this once auth is added.

create table if not exists public.sogood_rag (
  id uuid primary key,
  -- Company identifier (URL).
  company text,
  type text not null default 'results',
  social_entry text,
  context text,
  title text not null,
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.sogood_rag
  add column if not exists company text;

-- If you previously created `company` with the wrong type, coerce it to text.
do $$
begin
  if exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'sogood_rag'
      and a.attname = 'company'
      and format_type(a.atttypid, a.atttypmod) <> 'text'
  ) then
    execute 'alter table public.sogood_rag alter column company type text using company::text';
  end if;
end $$;

alter table public.sogood_rag
  add column if not exists type text not null default 'results';

alter table public.sogood_rag
  add column if not exists social_entry text;

alter table public.sogood_rag
  add column if not exists context text;

-- `company` is a text URL, so we do not enforce a FK here.
-- If you created an older FK, drop it (optional, safe).
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'sogood_rag_company_id_fkey') then
    execute 'alter table public.sogood_rag drop constraint sogood_rag_company_id_fkey';
  end if;
  if exists (select 1 from pg_constraint where conname = 'sogood_rag_company_fkey') then
    execute 'alter table public.sogood_rag drop constraint sogood_rag_company_fkey';
  end if;
end $$;

create index if not exists sogood_rag_company_idx on public.sogood_rag (company);

alter table public.sogood_rag enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sogood_rag' and policyname = 'anon_select'
  ) then
    create policy anon_select on public.sogood_rag for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sogood_rag' and policyname = 'anon_insert'
  ) then
    create policy anon_insert on public.sogood_rag for insert with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sogood_rag' and policyname = 'anon_update'
  ) then
    create policy anon_update on public.sogood_rag for update using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sogood_rag' and policyname = 'anon_delete'
  ) then
    create policy anon_delete on public.sogood_rag for delete using (true);
  end if;
end $$;
