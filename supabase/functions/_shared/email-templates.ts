// CueDeck Email Templates
// Founder welcome email sequence with branded HTML templates

export const BRAND = {
  name: 'CueDeck',
  tagline: 'Run every session. Own every moment.',
  color: '#4A8EFF',
  darkColor: '#1a1a2e',
  logo: 'https://www.cuedeck.io/logo.png',
  website: 'https://www.cuedeck.io',
  app: 'https://app.cuedeck.io',
  founder: {
    name: 'Sheriff',
    title: 'Founder & CEO',
    email: 'sheriff@cuedeck.io',
    photo: 'https://www.cuedeck.io/team/sheriff.jpg'
  }
}

// Base email wrapper with CueDeck branding
const emailWrapper = (content: string, preheader = '') => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>CueDeck</title>
  <style>
    body { margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    .wrapper { width: 100%; background-color: #f4f4f5; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, ${BRAND.darkColor}, #2d2d44); padding: 32px; text-align: center; }
    .logo { font-size: 28px; font-weight: 700; color: ${BRAND.color}; text-decoration: none; }
    .tagline { color: rgba(255,255,255,0.7); font-size: 12px; margin-top: 8px; letter-spacing: 1px; }
    .content { padding: 40px 32px; color: #374151; line-height: 1.7; font-size: 16px; }
    .content h1 { color: ${BRAND.darkColor}; font-size: 24px; margin: 0 0 24px; }
    .content p { margin: 0 0 16px; }
    .content ul { margin: 16px 0; padding-left: 0; list-style: none; }
    .content li { padding: 12px 16px; background: #f8fafc; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid ${BRAND.color}; }
    .content li strong { color: ${BRAND.darkColor}; }
    .cta-button { display: inline-block; background: ${BRAND.color}; color: #ffffff !important; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 24px 0; }
    .tip-box { background: linear-gradient(135deg, #fef3c7, #fef9c3); border: 1px solid #fcd34d; border-radius: 8px; padding: 16px; margin: 24px 0; }
    .tip-box strong { color: #92400e; }
    .signature { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; }
    .signature-photo { width: 64px; height: 64px; border-radius: 50%; margin-bottom: 12px; }
    .signature-name { font-weight: 600; color: ${BRAND.darkColor}; margin: 0; }
    .signature-title { color: #6b7280; font-size: 14px; margin: 4px 0 0; }
    .footer { background: #f8fafc; padding: 24px 32px; text-align: center; border-top: 1px solid #e5e7eb; }
    .footer p { color: #9ca3af; font-size: 12px; margin: 0 0 8px; }
    .footer a { color: ${BRAND.color}; text-decoration: none; }
    .preheader { display: none; max-height: 0; overflow: hidden; }
    @media only screen and (max-width: 600px) {
      .content { padding: 24px 20px; }
      .header { padding: 24px 20px; }
    }
  </style>
</head>
<body>
  <div class="preheader">${preheader}</div>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <a href="${BRAND.website}" class="logo">${BRAND.name}</a>
        <div class="tagline">${BRAND.tagline}</div>
      </div>
      ${content}
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.</p>
        <p>
          <a href="${BRAND.website}">Website</a> ·
          <a href="${BRAND.app}">Dashboard</a> ·
          <a href="${BRAND.website}/docs">Docs</a>
        </p>
        <p style="margin-top: 16px;">
          You're receiving this because you signed up for CueDeck.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`

export interface UserData {
  firstName?: string
  name?: string
  email: string
  plan?: string
}

// Email 1: Founder Welcome (sent immediately after first login)
export function founderWelcomeEmail(user: UserData) {
  const firstName = user.firstName || user.name?.split(' ')[0] || 'there'

  const content = `
    <div class="content">
      <h1>Welcome to CueDeck, ${firstName}! 🎉</h1>

      <p>I noticed you just logged into CueDeck for the first time – welcome aboard!</p>

      <p>I'm ${BRAND.founder.name}, the founder of CueDeck. I built this because I've seen too many live events fall apart due to miscommunication between directors, stage managers, and AV teams. CueDeck is the command center I wish I had.</p>

      <p>Here's how to get the most out of your first session:</p>

      <ul>
        <li><strong>1. Create your first event</strong> – Takes about 2 minutes. Just name it and set the date.</li>
        <li><strong>2. Invite your team</strong> – They'll each get role-specific dashboards (Director, Stage, AV, etc.)</li>
        <li><strong>3. Run a test session</strong> – See how the 8-state session machine keeps everyone in sync.</li>
      </ul>

      <a href="${BRAND.app}" class="cta-button">Open CueDeck Dashboard →</a>

      <div class="tip-box">
        <strong>💡 Pro tip:</strong> Press <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">Ctrl+K</code> anywhere in the app for the command palette. It's the fastest way to navigate.
      </div>

      <p>Reply to this email anytime – it comes directly to me, and I read every single one. I'd love to hear what brought you to CueDeck.</p>

      <div class="signature">
        <img src="${BRAND.founder.photo}" alt="${BRAND.founder.name}" class="signature-photo" onerror="this.style.display='none'">
        <p class="signature-name">${BRAND.founder.name}</p>
        <p class="signature-title">${BRAND.founder.title}, CueDeck</p>
      </div>
    </div>
  `

  return {
    subject: `Welcome to CueDeck, ${firstName}! A quick note from our founder`,
    html: emailWrapper(content, `Here's how to get started with CueDeck in 3 simple steps...`),
    text: `
Welcome to CueDeck, ${firstName}!

I noticed you just logged into CueDeck for the first time – welcome aboard!

I'm ${BRAND.founder.name}, the founder of CueDeck. I built this because I've seen too many live events fall apart due to miscommunication between directors, stage managers, and AV teams.

Here's how to get the most out of your first session:

1. Create your first event – Takes about 2 minutes
2. Invite your team – They'll get role-specific dashboards
3. Run a test session – See how the 8-state machine works

Pro tip: Press Ctrl+K anywhere for the command palette.

Open Dashboard: ${BRAND.app}

Reply to this email anytime – I read every one.

${BRAND.founder.name}
${BRAND.founder.title}, CueDeck
    `.trim()
  }
}

// Email 2: Feature Deep Dive (Day 3)
export function featureDeepDiveEmail(user: UserData) {
  const firstName = user.firstName || user.name?.split(' ')[0] || 'there'

  const content = `
    <div class="content">
      <h1>3 features most teams miss 🔍</h1>

      <p>Hey ${firstName},</p>

      <p>It's been a few days since you joined CueDeck. I wanted to share three powerful features that most new teams don't discover right away:</p>

      <ul>
        <li>
          <strong>🤖 AI Incident Advisor</strong><br>
          When something goes wrong mid-session, the AI suggests fixes based on what's worked before. Find it in the session sidebar.
        </li>
        <li>
          <strong>📺 Live Signage Control</strong><br>
          Push session info, speaker names, and countdown timers to lobby displays in real-time. Go to Settings → Signage.
        </li>
        <li>
          <strong>🌐 Interpreter Dashboard</strong><br>
          Give your interpreters their own view with language-specific cues and timing. Perfect for multilingual events.
        </li>
      </ul>

      <a href="${BRAND.app}" class="cta-button">Explore These Features →</a>

      <p>Have you had a chance to run your first session yet? If you're stuck on anything, just reply – I'm here to help.</p>

      <div class="signature">
        <p class="signature-name">${BRAND.founder.name}</p>
        <p class="signature-title">${BRAND.founder.title}, CueDeck</p>
      </div>
    </div>
  `

  return {
    subject: `${firstName}, 3 CueDeck features most teams miss`,
    html: emailWrapper(content, `Discover the AI Incident Advisor, Live Signage, and more...`),
    text: `
Hey ${firstName},

It's been a few days since you joined CueDeck. Here are 3 features most teams miss:

1. AI Incident Advisor - When something goes wrong mid-session, the AI suggests fixes.
2. Live Signage Control - Push session info to lobby displays in real-time.
3. Interpreter Dashboard - Language-specific cues for multilingual events.

Explore: ${BRAND.app}

Reply if you need help!

${BRAND.founder.name}
${BRAND.founder.title}, CueDeck
    `.trim()
  }
}

// Email 3: Social Proof + Tips (Day 7)
export function socialProofEmail(user: UserData) {
  const firstName = user.firstName || user.name?.split(' ')[0] || 'there'

  const content = `
    <div class="content">
      <h1>How teams like yours use CueDeck</h1>

      <p>Hey ${firstName},</p>

      <p>One week in! I wanted to share how some of our most successful teams are using CueDeck:</p>

      <div style="background:#f8fafc;border-radius:12px;padding:24px;margin:24px 0;">
        <p style="font-style:italic;margin:0 0 16px;color:#475569;">"We used to have 3 people on radios coordinating sessions. Now one person manages everything from CueDeck while everyone else focuses on their actual jobs."</p>
        <p style="margin:0;font-weight:600;color:${BRAND.darkColor};">— Sarah M., Conference Director at TechConf Europe</p>
      </div>

      <p><strong>Quick wins our power users swear by:</strong></p>

      <ul>
        <li><strong>Import sessions from CSV</strong> – Upload your agenda spreadsheet and we'll create all sessions automatically.</li>
        <li><strong>Set up auto-start</strong> – Sessions can begin automatically at their scheduled time.</li>
        <li><strong>Use keyboard shortcuts</strong> – <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">Space</code> to toggle session state, <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">B</code> to broadcast.</li>
      </ul>

      <a href="${BRAND.app}" class="cta-button">Try These Today →</a>

      <p>What's your next event? I'd love to hear how you're planning to use CueDeck.</p>

      <div class="signature">
        <p class="signature-name">${BRAND.founder.name}</p>
        <p class="signature-title">${BRAND.founder.title}, CueDeck</p>
      </div>
    </div>
  `

  return {
    subject: `How teams like yours use CueDeck`,
    html: emailWrapper(content, `Quick wins from our power users + a customer story`),
    text: `
Hey ${firstName},

One week in! Here's how successful teams use CueDeck:

"We used to have 3 people on radios coordinating sessions. Now one person manages everything from CueDeck."
— Sarah M., Conference Director at TechConf Europe

Quick wins:
- Import sessions from CSV
- Set up auto-start
- Use keyboard shortcuts (Space, B)

Try these: ${BRAND.app}

${BRAND.founder.name}
${BRAND.founder.title}, CueDeck
    `.trim()
  }
}

// Email 4: Check-in (Day 14)
export function checkInEmail(user: UserData) {
  const firstName = user.firstName || user.name?.split(' ')[0] || 'there'
  const plan = user.plan || 'trial'

  const upgradeBlock = plan === 'trial' ? `
    <div class="tip-box">
      <strong>📅 Your trial status:</strong> You're currently on the free tier. When you're ready for unlimited sessions and team members, our Pro plan is €99/month – <a href="${BRAND.website}/pricing">see all plans</a>.
    </div>
  ` : ''

  const content = `
    <div class="content">
      <h1>How's it going, ${firstName}?</h1>

      <p>It's been two weeks since you started with CueDeck. I wanted to check in personally.</p>

      <p><strong>Quick questions:</strong></p>
      <ul>
        <li>Have you been able to run a session yet?</li>
        <li>Is there anything confusing or missing?</li>
        <li>What's your next event coming up?</li>
      </ul>

      ${upgradeBlock}

      <p>I read every reply personally. Whether it's feedback, questions, or just saying hi – I'd love to hear from you.</p>

      <a href="mailto:${BRAND.founder.email}" class="cta-button">Reply to ${BRAND.founder.name} →</a>

      <p>Thanks for giving CueDeck a try. We're building this for people like you.</p>

      <div class="signature">
        <p class="signature-name">${BRAND.founder.name}</p>
        <p class="signature-title">${BRAND.founder.title}, CueDeck</p>
      </div>
    </div>
  `

  return {
    subject: `Quick check-in, ${firstName}`,
    html: emailWrapper(content, `How's your experience with CueDeck so far?`),
    text: `
Hey ${firstName},

It's been two weeks since you started with CueDeck. I wanted to check in.

Quick questions:
- Have you been able to run a session yet?
- Is there anything confusing or missing?
- What's your next event?

I read every reply personally.

Reply to: ${BRAND.founder.email}

${BRAND.founder.name}
${BRAND.founder.title}, CueDeck
    `.trim()
  }
}

// Email sequence configuration
export const EMAIL_SEQUENCE = [
  { id: 'founder-welcome', templateFn: founderWelcomeEmail, delayDays: 0 },
  { id: 'feature-deep-dive', templateFn: featureDeepDiveEmail, delayDays: 3 },
  { id: 'social-proof', templateFn: socialProofEmail, delayDays: 7 },
  { id: 'check-in', templateFn: checkInEmail, delayDays: 14 },
]
