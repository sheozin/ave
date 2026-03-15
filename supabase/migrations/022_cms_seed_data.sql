-- CueDeck CMS — Seed Data
-- Migration: cms_002_seed_data.sql

-- ─── Blog Tags ──────────────────────────────────────────────────────────────
insert into blog_tags (id, name, slug, color) values
  ('00000000-0000-0000-0001-000000000001', 'Product News', 'product-news', '#4A8EFF'),
  ('00000000-0000-0000-0001-000000000002', 'How-To Guides', 'how-to-guides', '#0ECECE'),
  ('00000000-0000-0000-0001-000000000003', 'Event Production', 'event-production', '#8B5CF6'),
  ('00000000-0000-0000-0001-000000000004', 'Tips & Tricks', 'tips-and-tricks', '#F59E0B'),
  ('00000000-0000-0000-0001-000000000005', 'Case Studies', 'case-studies', '#10B981')
on conflict (id) do nothing;

-- ─── Blog Posts ─────────────────────────────────────────────────────────────
insert into blog_posts (id, slug, title, excerpt, content_json, tags, status, published_at, read_time_minutes) values
  (
    '00000000-0000-0000-0002-000000000001',
    'introducing-cuedeck-2026',
    'Introducing CueDeck 2026: The Future of Live Event Production',
    'We are thrilled to announce the next generation of CueDeck — packed with real-time collaboration, AI-powered cue suggestions, and a brand new signage system.',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"We are thrilled to announce the next generation of CueDeck."}]}]}',
    '{"product-news"}',
    'published',
    now() - interval '30 days',
    4
  ),
  (
    '00000000-0000-0000-0002-000000000002',
    'mastering-stage-timers',
    'Mastering Stage Timers: A Director''s Complete Guide',
    'Learn how to configure stage timer displays, set overrun warnings, and keep your conference on schedule with CueDeck''s precision timing tools.',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Stage timers are one of the most powerful features in CueDeck."}]}]}',
    '{"how-to-guides","tips-and-tricks"}',
    'published',
    now() - interval '20 days',
    7
  ),
  (
    '00000000-0000-0000-0003-000000000003',
    'scaling-500-person-conference',
    'How We Ran a 500-Person Conference With a 2-Person AV Team',
    'A case study from a European tech summit where CueDeck enabled a lean team to manage 8 tracks simultaneously with zero dropped cues.',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Running a large multi-track conference with a small team is challenging."}]}]}',
    '{"case-studies","event-production"}',
    'published',
    now() - interval '10 days',
    8
  ),
  (
    '00000000-0000-0000-0002-000000000004',
    'signage-best-practices',
    '10 Signage Best Practices for Conference Displays',
    'From welcome screens to live session tickers, here are the 10 best practices our power users follow for impactful conference signage.',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Conference signage is often an afterthought."}]}]}',
    '{"tips-and-tricks","event-production"}',
    'draft',
    null,
    6
  )
on conflict (id) do nothing;

-- ─── Testimonials ───────────────────────────────────────────────────────────
insert into testimonials (id, author_name, author_title, company, quote, rating, is_featured, order_index) values
  (
    '00000000-0000-0000-0003-000000000001',
    'Sarah Müller',
    'Head of Events',
    'TechConf Europe',
    'CueDeck transformed how we run our 3-day conference. The real-time coordination between our AV team and stage managers is seamless.',
    5, true, 1
  ),
  (
    '00000000-0000-0000-0003-000000000002',
    'James Okafor',
    'Production Director',
    'Global Summit Series',
    'We switched from a spreadsheet-and-radio setup to CueDeck and never looked back. The delay cascade feature alone saves us hours of manual work.',
    5, true, 2
  ),
  (
    '00000000-0000-0000-0003-000000000003',
    'Ana Kowalski',
    'AV Manager',
    'Innovate Copenhagen',
    'The stage timer display is a game-changer. Speakers love seeing their time clearly and our stage crew can finally focus on other tasks.',
    5, false, 3
  )
on conflict (id) do nothing;

-- ─── Pricing Plans ──────────────────────────────────────────────────────────
insert into pricing_plans (id, name, slug, price_monthly, price_annual, features_json, cta_label, cta_url, is_highlighted, order_index) values
  (
    '00000000-0000-0000-0004-000000000001',
    'Pay Per Event',
    'pay-per-event',
    39.00,
    39.00,
    '["Up to 1 event", "All display modes", "Up to 3 operators", "Email support", "48-hour setup"]',
    'Book Event',
    '/contact',
    false,
    1
  ),
  (
    '00000000-0000-0000-0004-000000000002',
    'Starter',
    'starter',
    59.00,
    47.00,
    '["Unlimited events", "All display modes", "Up to 10 operators", "Priority support", "Custom branding", "AI cue assistant"]',
    'Start Free Trial',
    '/contact',
    false,
    2
  ),
  (
    '00000000-0000-0000-0004-000000000003',
    'Pro',
    'pro',
    99.00,
    79.00,
    '["Everything in Starter", "Unlimited operators", "Multi-venue support", "API access", "Dedicated onboarding", "SLA guarantee", "White-label signage"]',
    'Talk to Sales',
    '/contact',
    true,
    3
  )
on conflict (id) do nothing;

-- ─── Feature Cards ──────────────────────────────────────────────────────────
insert into feature_cards (id, title, description, icon_name, category, order_index) values
  ('00000000-0000-0000-0005-000000000001', 'Real-time Session Control', 'Manage session states from PLANNED to LIVE to ENDED with one click. Every operator sees changes instantly.', 'Zap', 'core', 1),
  ('00000000-0000-0000-0005-000000000002', 'Delay Cascade', 'Running late? Apply a delay once and watch it ripple through every remaining session automatically.', 'Clock', 'core', 2),
  ('00000000-0000-0000-0005-000000000003', 'Digital Signage', '11 display modes: welcome, timeline, schedule, stage timer, sponsor loop, and more. No extra software needed.', 'Monitor', 'signage', 3),
  ('00000000-0000-0000-0005-000000000004', 'Role-based Access', 'Director, Stage, AV, Interpretation, Registration, and Signage roles — each with exactly the right tools.', 'Users', 'security', 4),
  ('00000000-0000-0000-0005-000000000005', 'AI Cue Engine', 'Get pre-cue alerts 8 minutes before sessions. AI diagnoses incidents and suggests fixes in real time.', 'Brain', 'ai', 5),
  ('00000000-0000-0000-0005-000000000006', 'Broadcast Bar', 'Send instant all-operator announcements with preset messages or custom text. Dismissible per role.', 'Radio', 'core', 6)
on conflict (id) do nothing;

-- ─── FAQs ───────────────────────────────────────────────────────────────────
insert into faqs (id, question, answer_html, category, order_index) values
  (
    '00000000-0000-0000-0006-000000000001',
    'How many events can I run simultaneously?',
    '<p>Each plan supports one active event at a time. If you need multi-event support, contact us for an enterprise plan.</p>',
    'billing', 1
  ),
  (
    '00000000-0000-0000-0006-000000000002',
    'What devices do operators use?',
    '<p>CueDeck works in any modern browser — Chrome, Firefox, Safari on desktop or tablet. No app download required.</p>',
    'technical', 2
  ),
  (
    '00000000-0000-0000-0006-000000000003',
    'How does the signage system work?',
    '<p>You pair a display device (any screen with a browser) to your event using a pairing code. Choose from 11 display modes and control everything from the console.</p>',
    'features', 3
  ),
  (
    '00000000-0000-0000-0006-000000000004',
    'Is there a free trial?',
    '<p>Yes! The Starter plan includes a 14-day free trial with no credit card required. Pay-per-event plans are charged after the event completes.</p>',
    'billing', 4
  ),
  (
    '00000000-0000-0000-0006-000000000005',
    'What happens if the internet goes down?',
    '<p>CueDeck uses Supabase Realtime for synchronisation. We recommend a backup 4G connection for the director. The display pages can show a cached last-known state.</p>',
    'technical', 5
  ),
  (
    '00000000-0000-0000-0006-000000000006',
    'Can I white-label the signage displays?',
    '<p>Yes, on the Pro plan. You can add your own logo, colors, and remove CueDeck branding from all signage displays.</p>',
    'features', 6
  )
on conflict (id) do nothing;

-- ─── Changelog Items ────────────────────────────────────────────────────────
insert into changelog_items (id, version, title, type, published_at) values
  ('00000000-0000-0000-0007-000000000001', '2.5.0', 'Stage Timer Display Mode', 'new', now() - interval '5 days'),
  ('00000000-0000-0000-0007-000000000002', '2.5.0', 'Display Pairing with QR Code', 'new', now() - interval '5 days'),
  ('00000000-0000-0000-0007-000000000003', '2.4.0', 'AI Cue Engine Pre-alerts', 'new', now() - interval '30 days'),
  ('00000000-0000-0000-0007-000000000004', '2.4.0', 'User Profiles with Avatar Upload', 'improved', now() - interval '30 days'),
  ('00000000-0000-0000-0007-000000000005', '2.3.0', 'Promo Codes for Event Registration', 'new', now() - interval '60 days'),
  ('00000000-0000-0000-0007-000000000006', '2.3.0', 'Fixed delay cascade with cancelled sessions', 'fixed', now() - interval '60 days')
on conflict (id) do nothing;

-- ─── Site Settings ──────────────────────────────────────────────────────────
insert into site_settings (key, value) values
  ('site_name', '"CueDeck"'),
  ('site_tagline', '"The production console for live events"'),
  ('site_url', '"https://www.cuedeck.io"'),
  ('app_url', '"https://app.cuedeck.io"'),
  ('support_email', '"hello@cuedeck.io"'),
  ('social_twitter', '"@cuedeck"'),
  ('social_linkedin', '"https://linkedin.com/company/cuedeck"'),
  ('maintenance_mode', 'false'),
  ('signup_open', 'true')
on conflict (key) do nothing;

-- ─── Pages ──────────────────────────────────────────────────────────────────
insert into pages (id, slug, title, meta_title, meta_description, status, published_at) values
  ('00000000-0000-0000-0008-000000000001', 'home', 'Homepage', 'CueDeck — Live Event Production Console', 'The all-in-one production console for managing live conferences. Real-time session control, digital signage, and AI-powered cue management.', 'published', now()),
  ('00000000-0000-0000-0008-000000000002', 'pricing', 'Pricing', 'CueDeck Pricing — Pay Per Event or Monthly Plans', 'Simple, transparent pricing for event teams of any size. Pay per event or subscribe monthly.', 'published', now()),
  ('00000000-0000-0000-0008-000000000003', 'about', 'About', 'About CueDeck — Built by Event Professionals', 'Learn about the team behind CueDeck and why we built the production console we always wished we had.', 'published', now())
on conflict (id) do nothing;
