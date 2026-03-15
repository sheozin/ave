-- CueDeck CMS Admin Dashboard — Initial Schema
-- Migration: cms_001_initial_schema.sql

-- ─── CMS Users ─────────────────────────────────────────────────────────────
create table if not exists cms_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null default '',
  avatar_url text,
  role text not null default 'viewer' check (role in ('super_admin', 'admin', 'editor', 'viewer')),
  last_active_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table cms_users enable row level security;

create policy "cms_users: super_admin full access" on cms_users
  using (exists (select 1 from cms_users where id = auth.uid() and role = 'super_admin'));

create policy "cms_users: self read" on cms_users for select
  using (id = auth.uid());

create policy "cms_users: self update" on cms_users for update
  using (id = auth.uid());

-- ─── Pages ──────────────────────────────────────────────────────────────────
create table if not exists pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  meta_title text,
  meta_description text,
  og_image text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_by uuid references auth.users(id),
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table pages enable row level security;

create policy "pages: admins+editors read" on pages for select
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

create policy "pages: admins+editors write" on pages for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Page Sections ──────────────────────────────────────────────────────────
create table if not exists page_sections (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references pages(id) on delete cascade,
  section_type text not null,
  order_index integer not null default 0,
  content_json jsonb not null default '{}',
  is_visible boolean not null default true,
  updated_at timestamptz default now()
);

alter table page_sections enable row level security;

create policy "page_sections: admins+editors" on page_sections for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Blog Tags ──────────────────────────────────────────────────────────────
create table if not exists blog_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  color text not null default '#4A8EFF'
);

alter table blog_tags enable row level security;

create policy "blog_tags: all read" on blog_tags for select using (true);

create policy "blog_tags: admins+editors write" on blog_tags for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Blog Posts ─────────────────────────────────────────────────────────────
create table if not exists blog_posts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text,
  content_json jsonb not null default '{}',
  cover_image text,
  author_id uuid references auth.users(id),
  tags text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'scheduled', 'archived')),
  published_at timestamptz,
  read_time_minutes integer not null default 5,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table blog_posts enable row level security;

create policy "blog_posts: public read published" on blog_posts for select
  using (status = 'published' or exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

create policy "blog_posts: admins+editors write" on blog_posts for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Media Assets ───────────────────────────────────────────────────────────
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  url text not null,
  alt_text text,
  file_type text not null default 'image',
  file_size_kb integer not null default 0,
  width integer,
  height integer,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table media_assets enable row level security;

create policy "media_assets: admins+editors+viewers read" on media_assets for select
  using (exists (select 1 from cms_users where id = auth.uid()));

create policy "media_assets: admins+editors write" on media_assets for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Testimonials ───────────────────────────────────────────────────────────
create table if not exists testimonials (
  id uuid primary key default gen_random_uuid(),
  author_name text not null,
  author_title text,
  company text,
  avatar_url text,
  quote text not null,
  rating integer not null default 5 check (rating between 1 and 5),
  is_featured boolean not null default false,
  order_index integer not null default 0,
  created_at timestamptz default now()
);

alter table testimonials enable row level security;

create policy "testimonials: all read" on testimonials for select using (true);

create policy "testimonials: admins+editors write" on testimonials for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Pricing Plans ──────────────────────────────────────────────────────────
create table if not exists pricing_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  price_monthly numeric(10,2) not null default 0,
  price_annual numeric(10,2) not null default 0,
  features_json jsonb not null default '[]',
  cta_label text not null default 'Get Started',
  cta_url text not null default '/contact',
  is_highlighted boolean not null default false,
  is_active boolean not null default true,
  order_index integer not null default 0
);

alter table pricing_plans enable row level security;

create policy "pricing_plans: all read" on pricing_plans for select using (true);

create policy "pricing_plans: admins write" on pricing_plans for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin')));

-- ─── Feature Cards ──────────────────────────────────────────────────────────
create table if not exists feature_cards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  icon_name text not null default 'Zap',
  category text not null default 'general',
  order_index integer not null default 0,
  is_visible boolean not null default true
);

alter table feature_cards enable row level security;

create policy "feature_cards: all read" on feature_cards for select using (true);

create policy "feature_cards: admins+editors write" on feature_cards for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Team Members ───────────────────────────────────────────────────────────
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null,
  bio text,
  photo_url text,
  linkedin_url text,
  order_index integer not null default 0,
  is_visible boolean not null default true
);

alter table team_members enable row level security;

create policy "team_members: all read" on team_members for select using (true);

create policy "team_members: admins+editors write" on team_members for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── FAQs ───────────────────────────────────────────────────────────────────
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer_html text not null default '',
  category text not null default 'general',
  order_index integer not null default 0,
  is_published boolean not null default true
);

alter table faqs enable row level security;

create policy "faqs: all read published" on faqs for select
  using (is_published = true or exists (select 1 from cms_users where id = auth.uid()));

create policy "faqs: admins+editors write" on faqs for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Changelog Items ────────────────────────────────────────────────────────
create table if not exists changelog_items (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  title text not null,
  description_json jsonb not null default '{}',
  type text not null default 'new' check (type in ('new', 'improved', 'fixed', 'deprecated')),
  published_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table changelog_items enable row level security;

create policy "changelog_items: all read" on changelog_items for select using (true);

create policy "changelog_items: admins+editors write" on changelog_items for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin', 'editor')));

-- ─── Audit Log ──────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  diff_json jsonb,
  created_at timestamptz default now()
);

alter table audit_log enable row level security;

create policy "audit_log: admins read" on audit_log for select
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin')));

create policy "audit_log: authenticated insert" on audit_log for insert
  with check (exists (select 1 from cms_users where id = auth.uid()));

-- ─── Site Settings ──────────────────────────────────────────────────────────
create table if not exists site_settings (
  key text primary key,
  value jsonb not null default 'null',
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now()
);

alter table site_settings enable row level security;

create policy "site_settings: admins+editors read" on site_settings for select
  using (exists (select 1 from cms_users where id = auth.uid()));

create policy "site_settings: admins write" on site_settings for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin')));

-- ─── Redirects ──────────────────────────────────────────────────────────────
create table if not exists redirects (
  id uuid primary key default gen_random_uuid(),
  from_path text not null unique,
  to_path text not null,
  status_code integer not null default 301,
  is_active boolean not null default true
);

alter table redirects enable row level security;

create policy "redirects: all read active" on redirects for select
  using (is_active = true or exists (select 1 from cms_users where id = auth.uid()));

create policy "redirects: admins write" on redirects for all
  using (exists (select 1 from cms_users where id = auth.uid() and role in ('super_admin', 'admin')));

-- ─── Updated_at triggers ────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger pages_updated_at before update on pages
  for each row execute function update_updated_at();

create trigger blog_posts_updated_at before update on blog_posts
  for each row execute function update_updated_at();

create trigger page_sections_updated_at before update on page_sections
  for each row execute function update_updated_at();

-- ─── Auto-create cms_user on signup ─────────────────────────────────────────
create or replace function handle_new_cms_user()
returns trigger language plpgsql security definer as $$
begin
  insert into cms_users (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
