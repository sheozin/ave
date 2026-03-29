# CueDeck Marketing Website — CMS Admin Dashboard
## Claude Code Build Prompt

---

## PROJECT OVERVIEW

Build a **full-stack CMS Admin Dashboard** for the CueDeck marketing website. This is a production-ready content management system that allows non-technical team members to create, edit, and publish all content on the CueDeck marketing site — including landing pages, blog posts, pricing, testimonials, team bios, and feature announcements.

CueDeck is a real-time conference AV operations platform. The brand is **technical, premium, and professional** — dark UI, clean typography, blue/teal accent palette.

---

## TECH STACK (Latest Versions — Use All)

### Frontend (Admin UI)
- **Next.js 15** (App Router, Server Components, Turbopack)
- **React 19**
- **TypeScript 5.x** (strict mode throughout)
- **Tailwind CSS v4** + **shadcn/ui** (full component library)
- **Tiptap v2** — rich text / WYSIWYG editor with extensions
- **Zustand** — client state management
- **React Hook Form** + **Zod** — all forms with validation
- **TanStack Query v5** — server state, caching, optimistic updates
- **Framer Motion** — dashboard animations and transitions
- **Lucide React** — icons

### Backend / Database
- **Supabase** — PostgreSQL DB, Auth, Realtime, Storage
- **Supabase Storage** — media uploads (images, videos, PDFs)
- **Supabase Auth** — role-based access (Admin, Editor, Viewer)
- **Supabase Realtime** — live collaboration indicator (who's editing what)
- **Next.js Route Handlers** — API layer (REST + streaming)
- **Vercel AI SDK** — AI writing assistant integration

### AI Agents (Claude-Powered)
- **Anthropic Claude Sonnet** via Vercel AI SDK
- Four built-in AI Agent modules (see Agent Specs below)

### Developer Experience
- **ESLint** + **Prettier** + **Husky** pre-commit hooks
- **Vitest** + **Playwright** for unit and E2E tests
- **Storybook 8** — component development and documentation
- **Docker Compose** — local development environment
- **.env.local** configuration with full environment variable documentation

---

## DATABASE SCHEMA (Supabase PostgreSQL)

Create and apply full migration files for the following tables:

```sql
-- Core Content Tables
pages            (id, slug, title, meta_title, meta_description, og_image, status, published_at, created_by, updated_at)
page_sections    (id, page_id, section_type, order_index, content_json, is_visible, updated_at)
blog_posts       (id, slug, title, excerpt, content_json, cover_image, author_id, tags, status, published_at, read_time_minutes)
blog_tags        (id, name, slug, color)
media_assets     (id, filename, url, alt_text, file_type, file_size_kb, uploaded_by, created_at)

-- Marketing Content
testimonials     (id, author_name, author_title, company, avatar_url, quote, rating, is_featured, order_index)
pricing_plans    (id, name, slug, price_monthly, price_annual, features_json, cta_label, cta_url, is_highlighted, is_active)
feature_cards    (id, title, description, icon_name, category, order_index, is_visible)
team_members     (id, name, role, bio, photo_url, linkedin_url, order_index, is_visible)
faqs             (id, question, answer_html, category, order_index, is_published)
changelog_items  (id, version, title, description_json, type, published_at)

-- System Tables
users            (id, email, full_name, avatar_url, role, last_active_at)
audit_log        (id, user_id, action, entity_type, entity_id, diff_json, created_at)
site_settings    (key, value, updated_by, updated_at)
redirects        (id, from_path, to_path, status_code, is_active)
```

Implement full **Row Level Security (RLS)** policies. Seed realistic sample data for all tables so the dashboard is immediately functional and demonstrable.

---

## ADMIN DASHBOARD — FULL FEATURE SPECIFICATION

### 1. AUTHENTICATION & AUTHORIZATION
- Supabase Auth with magic link + password login
- Google OAuth SSO
- Role system: `super_admin` | `admin` | `editor` | `viewer`
- Protected routes with middleware
- Session management with automatic refresh
- Login page with CueDeck branding (dark theme, logo, animated background)

---

### 2. DASHBOARD HOME (`/admin`)
**Stats Cards Row:**
- Total published pages
- Blog posts this month
- Media storage used
- Recent activity feed (last 10 audit log entries)

**Quick Action Grid:**
- New Blog Post
- Edit Homepage
- Upload Media
- View Live Site

**Live Collaboration Panel:**
- Show avatars of other editors currently active
- "Currently editing: [page name]" via Supabase Realtime

**Content Calendar:**
- Mini calendar showing scheduled publish dates
- Upcoming posts/pages going live this week

---

### 3. PAGE EDITOR (`/admin/pages`)

**Page List View:**
- Table with: Title, Slug, Status (Draft/Published/Scheduled), Last Modified, Author
- Filter by status, search by title
- Bulk actions: publish, unpublish, delete
- Drag-to-reorder for nav order

**Page Builder (`/admin/pages/[id]/edit`):**

This is the core feature. Build a **visual section-based page builder**:

- **Left Panel**: Section library with draggable blocks:
  - Hero (headline + subtitle + CTA + background image)
  - Feature Grid (icon + title + description cards)
  - Testimonials Carousel
  - Pricing Table
  - Stats/Numbers Row
  - FAQ Accordion
  - CTA Banner
  - Blog Post Grid
  - Team Grid
  - Video Embed
  - Custom HTML block
  - Rich Text / Markdown block

- **Center Canvas**: Live preview of page with drag-to-reorder sections, click-to-edit inline

- **Right Panel**: Section properties editor (contextual to selected section):
  - All content fields for that section type
  - Visibility toggle
  - Background color / image picker
  - Padding/spacing controls

- **Top Bar**:
  - Page title (editable inline)
  - Status badge + Publish / Schedule / Save Draft buttons
  - Preview in new tab button (renders actual marketing site)
  - Version history dropdown (last 10 saves)
  - SEO panel toggle (slide-in drawer)

**SEO Panel (Drawer):**
- Meta title + character counter (60 char limit)
- Meta description + character counter (160 char limit)
- OG image upload/select from media
- Canonical URL
- noIndex toggle
- Real-time Google SERP preview (desktop + mobile)
- Schema markup JSON editor

---

### 4. BLOG MANAGER (`/admin/blog`)

**Post List:**
- Card-grid or table toggle view
- Cover image thumbnails
- Status, author, publish date, estimated read time
- Tag filter chips
- Search

**Post Editor (`/admin/blog/[id]/edit`):**
- **Tiptap WYSIWYG** with full toolbar:
  - Headings H1-H4, Bold, Italic, Underline, Strikethrough
  - Bullet list, numbered list, task list, blockquote, code block
  - Table insertion
  - Image upload (inline, with alt text)
  - YouTube/Vimeo embed
  - Internal link picker (search pages/posts)
  - Custom callout blocks (info, warning, tip)

- **Right Sidebar:**
  - Publish settings (date/time picker for scheduling)
  - Featured image with focal point selector
  - Author selector
  - Tag multi-select with create-new-tag inline
  - Reading time estimate (auto-calculated)
  - Slug (editable, auto-generated from title)

- **AI Writing Assistant Panel** (see Agent Specs)

---

### 5. MEDIA LIBRARY (`/admin/media`)
- Grid view with list view toggle
- Drag-and-drop upload zone (multi-file)
- Image preview modal with:
  - Alt text editor
  - Copy URL button
  - Used-on pages list
  - Dimensions + file size
- Filter by type (images, video, PDF, other)
- Search by filename or alt text
- Bulk select and delete
- Supabase Storage integration with signed URLs
- Image optimization via Next.js Image component

---

### 6. TESTIMONIALS MANAGER (`/admin/testimonials`)
- Card grid of all testimonials
- Add/Edit form: author, title, company, avatar upload, quote, star rating
- Drag-to-reorder (updates `order_index` in DB)
- Toggle featured status
- Live preview of how testimonial card renders on marketing site

---

### 7. PRICING MANAGER (`/admin/pricing`)
- Visual editor for all pricing plans
- Toggle monthly/annual pricing mode
- Features list editor (add/remove/reorder feature bullets)
- Highlight toggle (marks plan as "Most Popular")
- CTA label and URL per plan
- Activate/deactivate plans
- Live preview of pricing table as it appears on site

---

### 8. TEAM MANAGER (`/admin/team`)
- Photo upload + crop tool (square crop for avatars)
- Bio editor (rich text, ~150 words)
- LinkedIn URL
- Role/title
- Drag-to-reorder
- Show/hide toggle

---

### 9. FAQ MANAGER (`/admin/faqs`)
- Accordion preview matching live site styling
- Category grouping
- Drag-to-reorder within category
- Bulk publish/unpublish
- Rich text answer editor

---

### 10. SITE SETTINGS (`/admin/settings`)

**General:**
- Site name, tagline, logo upload (light + dark versions), favicon upload
- Contact email, support URL, social links (Twitter/X, LinkedIn, YouTube)

**Navigation:**
- Visual nav editor: drag-to-reorder menu items, add dropdowns, set CTA button item
- Separate desktop and mobile nav configuration

**Footer:**
- Column editor: heading + link list per column
- Copyright text
- Bottom links (Privacy Policy, Terms, etc.)

**Integrations:**
- Intercom app ID
- Google Analytics measurement ID
- HubSpot portal ID and form IDs
- Cookie consent settings

**Redirects:**
- Table of from→to redirects with 301/302 selector
- Active/inactive toggle
- Add/delete redirect rules

---

### 11. CHANGELOG / RELEASE NOTES (`/admin/changelog`)
- Version entries with type tags: `new` | `improved` | `fixed` | `deprecated`
- Rich text description
- Publish date
- Renders as public-facing changelog page

---

### 12. AUDIT LOG (`/admin/audit`)
- Full searchable history of all content changes
- Filter by user, entity type, date range
- Diff viewer (before/after JSON comparison with color-coded changes)
- Export to CSV

---

## AI AGENT MODULES (Claude-Powered)

Implement all four as sidebar panels inside relevant editors using **Vercel AI SDK** with **streaming responses**. All agents call `claude-sonnet-4-20250514`.

### Agent 1: AI Writing Assistant (Blog & Page Editor)
**UI:** Collapsible right panel with chat interface + action buttons

**Capabilities (each as a button + custom prompt input):**
- **Generate from Brief** — User enters a brief, AI writes full section/post draft
- **Improve Writing** — Rewrite selected text to be clearer, more compelling
- **Adjust Tone** — Rewrite for: Professional / Conversational / Technical / Persuasive
- **Expand Section** — Make selected content longer with more detail
- **Summarize** — Condense selected content
- **SEO Optimize** — Rewrite with target keyword naturally integrated
- **Translate** — Translate content to Polish or Arabic (CueDeck markets)
- **Generate Meta** — Auto-generate meta title + description from page content

**System Prompt Context:** Inject CueDeck brand voice guidelines, target audience (conference AV managers, event agencies), and current page/post content as context.

---

### Agent 2: SEO Analyzer
**UI:** Tab inside SEO drawer panel

**Analysis (runs on-demand or on save):**
- Keyword density analysis with suggestions
- Readability score (Flesch-Kincaid)
- Heading structure check (H1 uniqueness, H2/H3 hierarchy)
- Internal linking opportunities (suggests related pages from DB)
- Meta length validation
- Image alt text audit for page images
- Competitor keyword gap suggestions based on page topic

**Output:** Scored report (0–100) with actionable fixes listed by priority. Each fix has a one-click "Fix with AI" button that applies the suggestion.

---

### Agent 3: Content Consistency Checker
**UI:** Dashboard widget + per-post/page panel

**Checks:**
- Brand voice consistency (flags off-brand phrases)
- CueDeck product naming consistency (correct capitalization, no typos of product name)
- Duplicate content detection (compares against all other published content)
- Broken internal link detection
- Missing alt text audit across all media

**Output:** Issues list with severity (error / warning / info) and direct links to fix each one.

---

### Agent 4: Page Performance Advisor
**UI:** Separate `/admin/analytics` dashboard section

**Features:**
- Connect to Vercel Analytics or Plausible API
- AI-generated plain-English summary of traffic trends
- Identify top-performing pages and why (AI analysis)
- Identify underperforming pages with improvement suggestions
- A/B test suggestion generator: "These two headline variants to test on /pricing"
- Monthly content performance report generator (exportable as PDF)

---

## UI/UX DESIGN REQUIREMENTS

### Visual Theme
- **Dark mode first** — `#0A0E1A` base background, `#111827` card surfaces
- **Accent colors:** CueDeck blue `#4A8EFF`, teal `#0ECECE`, subtle green for success states
- **Typography:** `Geist` (headings) + `Geist Mono` (code/slugs) — install via `next/font`
- **Sidebar:** 240px fixed left nav, collapsible to icon-only mode
- **Topbar:** Breadcrumbs + user avatar + notifications bell + "View Live Site" button

### Navigation Structure
```
Sidebar Navigation:
├── Dashboard (home)
├── Content
│   ├── Pages
│   ├── Blog Posts
│   └── Changelog
├── Marketing
│   ├── Testimonials
│   ├── Pricing
│   ├── Team
│   └── FAQs
├── Media Library
├── AI Agents
│   └── Content Analyzer
├── Analytics
├── Settings
│   ├── General
│   ├── Navigation
│   ├── Integrations
│   └── Redirects
└── Audit Log
```

### Component Library Setup
Use `shadcn/ui` with full init. Install these components at minimum:
`button, card, dialog, drawer, dropdown-menu, form, input, label, popover, select, separator, sheet, sidebar, skeleton, table, tabs, textarea, toast, toggle, tooltip, badge, calendar, command, data-table (with TanStack Table)`

Also install and configure:
- `@tiptap/react` + all required extensions
- `react-dropzone` — media uploads
- `react-beautiful-dnd` or `@dnd-kit/core` — drag and drop
- `react-image-crop` — avatar/image cropping
- `date-fns` — date formatting
- `recharts` — analytics charts
- `cmdk` — command palette (Cmd+K)
- `sonner` — toast notifications

---

## COMMAND PALETTE
Implement a **Cmd+K command palette** (using `cmdk`) with:
- Search all pages, posts, media by title
- Quick nav: "Go to Dashboard", "New Blog Post", "Open Media Library"
- Recent items (last 5 visited)
- AI shortcuts: "Generate blog post about...", "Check SEO for..."

---

## REAL-TIME COLLABORATION
Using **Supabase Realtime Presence**:
- Show other logged-in editors as avatar dots in the sidebar
- When two editors open the same page, show a warning banner: "⚠️ Sarah is also editing this page"
- Lock sections being edited by another user (soft lock with override option)

---

## FILE STRUCTURE

```
cuedeck-cms/
├── app/
│   ├── (auth)/
│   │   └── login/
│   ├── admin/
│   │   ├── page.tsx                    # Dashboard home
│   │   ├── layout.tsx                  # Admin shell layout
│   │   ├── pages/
│   │   ├── blog/
│   │   ├── media/
│   │   ├── testimonials/
│   │   ├── pricing/
│   │   ├── team/
│   │   ├── faqs/
│   │   ├── changelog/
│   │   ├── analytics/
│   │   ├── audit/
│   │   └── settings/
│   └── api/
│       ├── ai/
│       │   ├── writing/route.ts
│       │   ├── seo/route.ts
│       │   └── analyze/route.ts
│       ├── pages/route.ts
│       ├── blog/route.ts
│       └── media/route.ts
├── components/
│   ├── ui/                             # shadcn components
│   ├── editor/
│   │   ├── TiptapEditor.tsx
│   │   ├── PageBuilder.tsx
│   │   ├── SectionLibrary.tsx
│   │   └── SeoPanel.tsx
│   ├── ai/
│   │   ├── WritingAssistant.tsx
│   │   ├── SeoAnalyzer.tsx
│   │   └── ConsistencyChecker.tsx
│   ├── layout/
│   │   ├── AdminSidebar.tsx
│   │   ├── AdminTopbar.tsx
│   │   └── CommandPalette.tsx
│   └── shared/
│       ├── MediaPicker.tsx
│       ├── ImageCrop.tsx
│       └── AuditDiff.tsx
├── lib/
│   ├── supabase/
│   │   ├── client.ts
│   │   ├── server.ts
│   │   └── middleware.ts
│   ├── ai/
│   │   └── prompts.ts                  # All system prompts
│   └── utils/
├── stores/
│   ├── editorStore.ts
│   ├── mediaStore.ts
│   └── uiStore.ts
├── supabase/
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   └── seed.sql
├── types/
│   └── database.types.ts               # Auto-generated from Supabase
├── middleware.ts                        # Auth protection
├── docker-compose.yml
└── .env.local.example
```

---

## ADDITIONAL REQUIREMENTS

1. **Full TypeScript types** — generate Supabase types from schema, use them everywhere, zero `any` types

2. **Optimistic Updates** — all mutations via TanStack Query with optimistic UI (changes appear instantly, roll back on error)

3. **Error Boundaries** — every major section wrapped with React Error Boundary + meaningful error UI

4. **Loading States** — skeleton screens for all list/table views, spinner with progress for file uploads

5. **Keyboard Shortcuts:**
   - `Cmd+S` — Save current document
   - `Cmd+K` — Open command palette
   - `Cmd+P` — Preview page
   - `Cmd+Shift+P` — Publish/unpublish toggle

6. **Responsive Admin** — mobile-friendly (tablet-down collapses sidebar, stacks panels)

7. **Dark/Light mode toggle** — persisted to localStorage, defaults dark

8. **README.md** — Full setup instructions, environment variables list, Supabase project setup steps, deployment to Vercel guide

9. **Environment Variables (.env.local.example):**
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
NEXT_PUBLIC_SITE_URL=
VERCEL_ANALYTICS_ID=
```

---

## DELIVERABLES CHECKLIST

When complete, the following must all work end-to-end:

- [ ] Login with Supabase Auth → redirects to `/admin`
- [ ] Dashboard shows live stats from DB
- [ ] Create a new page with the visual page builder, add 3 sections, publish it
- [ ] Create a blog post with Tiptap, upload a cover image, schedule publish
- [ ] Upload image to media library, use it in a page section
- [ ] Add a testimonial, reorder it via drag-and-drop
- [ ] Run AI Writing Assistant on blog post content (streaming response)
- [ ] Run SEO Analyzer on a page (get scored report)
- [ ] Edit site settings → save → verify changes in DB
- [ ] View audit log for all above changes with diffs
- [ ] Cmd+K command palette works with search

---

## NOTES FOR CLAUDE CODE

- Run `supabase init` and `supabase start` for local dev environment
- Use `npx shadcn@latest init` with New York style, zinc base color, CSS variables enabled
- Install all Tiptap extensions: StarterKit, Image, Link, Table, TaskList, Highlight, Typography, Placeholder, CharacterCount, Collaboration (for future real-time editing)
- For the AI agents, use `streamText` from Vercel AI SDK with `@ai-sdk/anthropic` provider
- Supabase realtime subscriptions should clean up on component unmount
- All DB mutations should invalidate relevant TanStack Query caches
- Use `next-safe-action` for type-safe server actions where appropriate
- The page builder section content should serialize to clean JSON stored in `page_sections.content_json`
- Media uploads should go directly to Supabase Storage bucket named `cuedeck-media` with public read access
- Seed data should make every section of the dashboard immediately usable without needing to add data first
