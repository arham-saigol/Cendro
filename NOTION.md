# Notion-Inspired Design System for Cendro

> Purpose: make Cendro feel like a calm, document-first operations workspace: fast, quiet, readable, and organized. This is an inspiration guide, not a directive to copy Notion branding, logos, proprietary assets, or exact UI text.

Cendro should look and feel like a structured company wiki that happens to manage tasks, SOPs, employees, permissions, analytics, and AI. The interface should stay visually quiet so the work feels easy to scan. Color is restrained. Typography does most of the hierarchy. Surfaces feel like paper. The AI panel feels integrated into the workspace, not bolted on.

---

## 1. Core Design Principles

### 1.1 Quiet workspace, useful density
- Cendro is an internal operations tool, so the UI should feel durable and low-friction.
- Prioritize dense but readable layouts: tables, boards, sidebars, and panels should fit a lot of work without feeling cramped.
- Avoid decorative chrome in core product screens. Let user content, tasks, SOP titles, statuses, and permissions be the focus.

### 1.2 Document-first structure
- Pages should feel like editable documents with embedded databases.
- Every major object should have a page-like treatment:
  - Company dashboard
  - Branch
  - Department
  - User profile
  - JD task
  - One-time task
  - SOP
  - Permission set
- Prefer inline editing, lightweight menus, and contextual controls over heavy modal flows.

### 1.3 Monochrome plus one confident blue
- Use neutral surfaces and text for almost everything.
- Use one structural blue for primary actions, active states, focus, and links.
- Use status colors only for meaning: overdue, blocked, done, risk, priority, etc.
- Do not make the app colorful for its own sake.

### 1.4 Soft paper calm
- Light theme should feel like warm paper, not clinical white.
- Dark theme should feel like Notion's dark workspace: charcoal, low contrast borders, and soft white text.
- Borders and subtle background shifts should define structure more often than shadows.

### 1.5 Fast, optimistic, collaborative
- Interactions should feel instant.
- Use optimistic updates for task completion, assignment, status changes, SOP edits, and permission changes.
- Prefer skeleton rows/cards over spinners.
- Real-time updates should quietly appear without interrupting the user.

---

## 2. Brand Personality

### 2.1 Personality attributes
- **Calm:** minimal visual noise, lots of whitespace, gentle contrast.
- **Competent:** clear hierarchy, predictable layouts, precise labels.
- **Collaborative:** ownership, comments, activity, and permissions are visible but understated.
- **Helpful:** AI and empty states should guide users without sounding salesy.
- **Operational:** built for actual daily work, not dashboards for show.

### 2.2 Voice and tone
Cendro's language should be short, direct, and supportive.

Use:
- “Assign task”
- “Create SOP”
- “Mark as done”
- “Ask AI”
- “Only visible to Admins and assigned Managers”
- “No overdue tasks”

Avoid:
- “Unlock productivity magic”
- “Supercharge your workflows”
- “Oopsie!”
- “You are not authorized to access this resource” when “You do not have access to this” is enough.

### 2.3 Writing rules
- Prefer sentence case: “One-time tasks”, not “One-Time Tasks”.
- Use verbs for buttons: “Create task”, “Invite employee”, “Save changes”.
- Use nouns for navigation: “Dashboard”, “JD tasks”, “SOPs”, “Company management”.
- Keep empty states useful: say what is missing and what to do next.
- Never expose internal permission logic in user-facing copy. Explain outcome, not implementation.

---

## 3. Color System

## 3.1 Light theme tokens

| Token | Hex | Use |
|---|---:|---|
| `canvas` | `#FFFFFF` | Main editor/page surface |
| `canvasSoft` | `#F6F5F4` | App background, marketing sections, subtle wells |
| `surface` | `#FFFFFF` | Cards, menus, modals, table bodies |
| `surfaceMuted` | `#F7F7F5` | Sidebar hover, table header, empty states |
| `surfacePressed` | `#EFEFED` | Pressed/active neutral controls |
| `ink` | `#0D0D0D` | Primary text |
| `inkSecondary` | `#31302E` | Secondary text |
| `inkMuted` | `#615D59` | Metadata, helper text |
| `inkFaint` | `#A39E98` | Placeholders, disabled text |
| `hairline` | `#E6E6E6` | Borders and dividers |
| `hairlineStrong` | `#D9D9D6` | Stronger separators |
| `primary` | `#0075DE` | Primary action, links, selected state |
| `primaryHover` | `#006AC8` | Primary hover |
| `primaryPressed` | `#005BAB` | Primary pressed |
| `onPrimary` | `#FFFFFF` | Text on primary |
| `focusRing` | `#2383E2` | Focus and active input outline |

## 3.2 Dark theme tokens

Observed Notion dark screenshots use a deep charcoal workspace, slightly lighter sidebar, subtle borders, and bright blue actions.

| Token | Hex | Use |
|---|---:|---|
| `darkCanvas` | `#191919` | Main workspace background |
| `darkSidebar` | `#202020` | Sidebar background |
| `darkSurface` | `#1F1F1F` | Cards, board columns, AI input |
| `darkSurfaceRaised` | `#252525` | Hovered rows, selected items, popovers |
| `darkSurfacePressed` | `#2F2F2F` | Active nav row, pressed controls |
| `darkInk` | `#F1F1F1` | Primary text |
| `darkInkSecondary` | `#D4D4D4` | Secondary labels |
| `darkInkMuted` | `#A8A8A8` | Metadata and placeholders |
| `darkInkFaint` | `#6F6F6F` | Disabled text |
| `darkHairline` | `#2F2F2F` | Borders and table lines |
| `darkHairlineStrong` | `#3A3A3A` | Panel separators |
| `darkPrimary` | `#2383E2` | New buttons, active page icon, focus |
| `darkPrimaryPressed` | `#1A73C9` | Pressed primary |
| `darkOnPrimary` | `#FFFFFF` | Text on blue buttons |

## 3.3 Status colors

Use muted backgrounds with stronger text. Status should be readable in tables, board cards, and AI summaries.

| Meaning | Light bg | Light text | Dark bg | Dark text |
|---|---:|---:|---:|---:|
| Not started / neutral | `#EFEFED` | `#615D59` | `#303030` | `#D4D4D4` |
| In progress | `#E6F1FC` | `#0B63B6` | `#1D3146` | `#6EA8E8` |
| Done | `#E6F4EA` | `#167A3B` | `#1E3A2B` | `#57C785` |
| Blocked / error | `#FCEAEA` | `#B42318` | `#452322` | `#FF8A80` |
| Warning / due soon | `#FFF4D6` | `#8A5A00` | `#44351A` | `#F2C86D` |
| High priority | `#F9E7E7` | `#A33A3A` | `#4A2A2A` | `#E88484` |
| Medium priority | `#F7EED8` | `#8A6300` | `#43351E` | `#D7B15F` |
| Low priority | `#E7F3EC` | `#2F7D4C` | `#263D30` | `#7DC99B` |

## 3.4 Color rules

Do:
- Use blue for the single most important action on a screen: “New”, “Create task”, “Save”, “Ask AI”.
- Use neutral active states for sidebar rows unless the page icon or small indicator needs blue.
- Use colored badges for task state and priority only.
- Keep table lines and card borders subtle.

Don't:
- Use multiple bright CTAs on the same screen.
- Use decorative accent colors for structural navigation.
- Use saturated backgrounds behind large areas of text.
- Make analytics dashboards rainbow-colored; use muted, semantic color only.

---

## 4. Typography

### 4.1 Font stack

Use Inter as the practical substitute for Notion's tuned Inter.

```css
font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
```

### 4.2 Type scale

| Token | Size | Weight | Line height | Letter spacing | Use |
|---|---:|---:|---:|---:|---|
| `display1` | 64px | 700 | 1.0 | -2.125px | Marketing hero only |
| `display2` | 54px | 700 | 1.04 | -1.875px | Large marketing sections |
| `h1` | 40px | 700 | 1.1 | -1px | Product landing page titles |
| `pageTitle` | 32px | 700 | 1.15 | -0.6px | App page titles |
| `h2` | 26px | 700 | 1.23 | -0.625px | Section headings |
| `h3` | 22px | 700 | 1.27 | -0.25px | Card titles |
| `title` | 20px | 600 | 1.4 | -0.125px | Panel titles, modal titles |
| `body` | 16px | 400 | 1.5 | 0 | Main readable text |
| `bodySm` | 15px | 400 | 1.33 | 0 | App body, nav, table rows |
| `label` | 14px | 500 | 1.35 | 0 | Form labels, property names |
| `caption` | 13px | 400 | 1.35 | 0 | Metadata, timestamps |
| `eyebrow` | 12px | 600 | 1.33 | +0.125px | Badges, tiny headings |

### 4.3 Typography rules

- Use tight, heavy headings and quiet body text.
- Product screens should mostly use `bodySm`, `label`, `caption`, and `pageTitle`.
- Avoid oversized dashboard numbers unless they genuinely help scanning.
- Use bold sparingly in tables; row titles can be 600, metadata stays 400.
- Never use decorative fonts.

---

## 5. Spacing, Sizing, and Shape

### 5.1 Spacing scale

| Token | Value | Use |
|---|---:|---|
| `0.5` | 4px | Icon/text gaps, compact controls |
| `1` | 8px | Base unit, row gaps |
| `1.5` | 12px | Dense card padding, sidebar row padding |
| `2` | 16px | Standard padding |
| `3` | 24px | Card and panel padding |
| `4` | 32px | Page section gap |
| `5` | 40px | Large page gap |
| `6` | 48px | Marketing section gap |

### 5.2 Radius scale

| Token | Value | Use |
|---|---:|---|
| `xs` | 4px | Inputs, small tags |
| `sm` | 5px | Sidebar rows, table chips |
| `md` | 8px | Utility buttons, menus, board cards |
| `lg` | 12px | Cards and panels |
| `xl` | 16px | Large containers and AI input |
| `full` | 9999px | Pills, avatars, round icon buttons |

### 5.3 Border and shadow

Prefer borders over shadows.

```css
--shadow-soft:
  0 0.175px 1.041px rgba(0,0,0,0.01),
  0 0.8px 2.925px rgba(0,0,0,0.02),
  0 2.025px 7.847px rgba(0,0,0,0.027),
  0 4px 18px rgba(0,0,0,0.04);

--shadow-elevated:
  0 4px 12px rgba(0,0,0,0.08),
  0 12px 28px rgba(0,0,0,0.10);
```

Use shadows for:
- Menus
- Popovers
- Modals
- Floating AI composer only if detached

Avoid shadows for:
- Normal table rows
- Sidebar sections
- Default cards on the canvas

---

## 6. App Shell

### 6.1 Overall layout

Cendro should use a three-panel Notion-like layout:

```text
┌───────────────┬──────────────────────────────────┬─────────────────┐
│ Sidebar       │ Main workspace                   │ AI panel        │
│ Navigation    │ Pages, tables, boards, SOPs      │ Assistant       │
└───────────────┴──────────────────────────────────┴─────────────────┘
```

- Sidebar width: 260-280px desktop.
- AI panel width: 380-460px when open.
- Main content has a max readable width for document pages but can expand for tables/boards.
- Use vertical dividers, not heavy borders.

### 6.2 Sidebar

Inspired by the screenshots:
- Dark theme sidebar: `#202020`.
- Active item: slightly lighter rounded row, not a loud blue block.
- Icons are small, monochrome, and aligned to a 16px grid.
- Section labels are muted and tiny.
- Workspace/user switcher appears at the top.
- Global actions and chat entry can sit at the bottom.

Sidebar groups for Cendro:
1. **Home**
   - Dashboard
   - My tasks
   - Inbox / notifications
2. **Work**
   - JD tasks
   - One-time tasks
   - SOPs
   - AI assistant
3. **Company**
   - Employees
   - Branches
   - Departments
   - Permissions
   - Analytics
4. **Private / Saved**
   - Personal views
   - Draft SOPs

Rules:
- Admins see company-wide sections.
- Managers see only scoped branches/departments/users.
- Employees see personal work and accessible SOPs.
- Hide unavailable navigation rather than showing many disabled items.

### 6.3 Top bar

Top bar should be quiet and contextual:
- Breadcrumbs on the left.
- Last edited / synced status near the right.
- Share/access control button.
- Favorite/star and overflow menu.
- Optional compact AI toggle.

Avoid a heavy global header; the sidebar already anchors the app.

### 6.4 Main page header

A Notion-like page header contains:
- Optional page icon.
- Large page title.
- One-line description.
- View tabs below the description.
- View tools aligned right: filter, sort, search, settings, new.

Example:

```text
[icon] SOPs
Create, review, and share operating procedures.

[All SOPs] [By department] [Needs review]                         Filter Sort Search New
```

---

## 7. Core Components

### 7.1 Buttons

#### Primary button
- Fill: blue.
- Text: white.
- Radius: 8px in app screens, full pill in marketing/onboarding.
- Use for one primary action per surface.

Examples:
- New
- Create task
- Save changes
- Ask AI

#### Secondary button
- White/light surface or dark raised surface.
- Hairline border.
- Neutral text.
- Use for secondary actions like “Cancel”, “Preview”, “Request changes”.

#### Ghost button
- Transparent by default.
- Slight background on hover/active.
- Use for toolbar icons, sidebar actions, table row menus.

#### Icon button
- 28-32px in dense app toolbars.
- 36-40px in panels/modals.
- Keep glyphs 16-18px.

### 7.2 Inputs

Inputs should be compact and squared-off compared with buttons.

- Radius: 4-8px.
- Height: 32-36px for dense forms.
- Border: subtle hairline.
- Focus: blue ring or border, never a glow-heavy effect.
- Placeholder text: muted.

Use inline fields for editable properties where possible:
- Assignee
- Department
- Branch
- Due date
- Recurrence
- Visibility
- Priority

### 7.3 Selects and menus

Menus should feel like small paper cards:
- Surface: white/dark raised.
- Border: hairline.
- Radius: 8px.
- Shadow: soft.
- Menu item height: 28-34px.
- Active/hover: muted background.

Every permission-sensitive menu should only show allowed actions.

### 7.4 Badges and pills

Use compact property-style pills.

Examples:
- `Admin`
- `Manager`
- `Employee`
- `Overdue`
- `Due today`
- `In progress`
- `Company-wide`
- `Branch: Dubai`
- `Department: Sales`

Rules:
- Keep labels short.
- Use muted fills.
- Use semantic colors only where meaning matters.
- Role badges can be neutral unless role distinction is critical.

### 7.5 Cards

Cards should be quiet containers, not decorative blocks.

Default card:
- Surface: `surface` / `darkSurface`.
- Radius: 12px.
- Border: hairline.
- Padding: 16-24px.

Board card:
- Radius: 8px.
- Padding: 12px.
- Border: subtle.
- Title weight: 600.
- Metadata uses small muted labels.

### 7.6 Tables / databases

Tables are central to Cendro.

Table rules:
- Header row: small muted labels with property icons.
- Row height: 36-44px.
- Row title: 600 weight.
- Dividers: 1px hairline.
- Hover: subtle surface shift.
- Inline actions appear on row hover/focus.
- Empty cells should be blank or muted “Empty”, not loud.

Useful columns:
- Task name
- Assignee
- Department
- Branch
- Status
- Priority
- Due date
- Last updated
- Visibility
- Created by

### 7.7 Boards / kanban

From the Projects screenshot:
- Columns use slightly tinted surfaces.
- Column headers are compact status pills with count.
- Cards sit inside columns with subtle border and status tint.
- “New task/project” row appears at bottom of each column.

For Cendro:
- JD tasks board: Not started / In progress / Needs review / Done.
- One-time tasks board: Upcoming / Due today / Overdue / Done.
- SOP board: Draft / In review / Approved / Needs update.

### 7.8 Modals

Use modals sparingly. Prefer side panels or inline editing.

Modal style:
- Width: 480-720px depending on content.
- Radius: 12-16px.
- Padding: 24px.
- Clear title and short helper text.
- Footer actions right-aligned.

Use modals for:
- Invite employee
- Confirm destructive action
- Create branch/department if it requires multiple fields
- Permission changes with impact summary

### 7.9 Toasts

Toasts should be quiet and specific.

Examples:
- “Task assigned to Sarah.”
- “SOP visibility updated.”
- “You do not have access to that employee.”

Style:
- Surface: raised.
- Radius: 12px.
- Border: hairline.
- Small icon optional.
- Auto-dismiss for success; persist or require action for errors.

---

## 8. AI Panel Design

The AI panel is a first-class workspace panel on the right side of the app.

### 8.1 Panel layout

- Width: 380-460px.
- Background matches main canvas in dark theme, with a left divider.
- Header: “AI assistant” or context-specific title like “New AI chat”.
- Empty state: centered assistant icon, short prompt, and 3-4 suggested actions.
- Composer fixed at bottom.

Suggested actions:
- Search SOPs
- Summarize overdue work
- Analyze performance
- Create a task
- Draft an SOP

### 8.2 Composer

Inspired by the screenshot:
- Large rounded rectangle, radius 14-16px.
- Blue focus border when active.
- Context pill at top-left inside composer, e.g. `SOPs`, `Sales department`, `My tasks`.
- Placeholder: “Ask about this workspace…” or “Do anything with AI…”
- Bottom row: attach/context controls left, mode selector and send right.

### 8.3 AI permission language

AI must communicate scope clearly but calmly.

Good:
- “I can answer using SOPs and tasks you have access to.”
- “I found 6 overdue tasks in your department.”
- “I cannot view company-wide analytics from your current role.”

Avoid:
- “Access denied.”
- “Permission error.”
- “You are unauthorized.”

### 8.4 AI result formatting

AI answers should use Notion-like document blocks:
- Short headings.
- Bulleted lists.
- Tables for structured task/SOP data.
- Inline chips for statuses and dates.
- Clear action buttons under the answer when applicable.

Example action row:

```text
[Create these tasks] [Open source SOP] [Copy summary]
```

---

## 9. Cendro Product Patterns

### 9.1 Dashboard

Admin dashboard:
- Company-wide task health.
- Overdue by branch/department.
- SOPs needing review.
- Employee workload.
- Recent activity.

Manager dashboard:
- Scoped team task health.
- Team members needing attention.
- Branch/department SOP updates.

Employee dashboard:
- My tasks due today.
- Overdue tasks.
- SOPs assigned/read-required.
- Personal stats.

Design:
- Use quiet metric cards.
- Avoid giant colorful charts.
- Lead with “What needs attention?”

### 9.2 JD tasks

JD tasks are recurring job-description tasks.

Recommended views:
- Table: all recurring tasks.
- Board: by status.
- Calendar: due schedule.
- By assignee.

Important properties:
- Owner
- Recurrence
- Department
- Branch
- Status
- Last completed
- Next due
- Evidence/notes

### 9.3 One-time tasks

One-time tasks are due-date based.

Recommended views:
- My open tasks.
- By due date.
- By assignee.
- Overdue.
- Done archive.

Use a lightweight task detail side panel with:
- Title
- Assignee
- Due date
- Priority
- Status
- Description
- Comments/activity
- Related SOPs

### 9.4 SOPs

SOPs should feel like Notion documents with structured properties.

SOP page anatomy:
- Icon
- Title
- Summary
- Properties: owner, department, visibility, last reviewed, review cadence
- Content blocks
- Related tasks
- Approval/review status
- Activity/comments

Visibility chips:
- Company-wide
- Branch-wide
- Department-wide
- Specific users

### 9.5 Company management

Keep admin tools calm and table-driven.

Sections:
- Employees
- Roles and permissions
- Branches
- Departments
- Company settings
- Audit/activity

Permission editing should show impact summaries:
- “This manager will be able to view 12 employees and 34 tasks.”
- “This SOP will become visible to everyone in Sales.”

---

## 10. Interaction Guidelines

### 10.1 Hover and active states

- Hover: subtle background shift only.
- Active nav row: rounded muted row.
- Selected table row: slight tint plus optional left blue indicator.
- Pressed button: darker fill or stronger neutral background.

### 10.2 Inline editing

Prefer:
- Click title to edit.
- Click property chip to change.
- Enter saves text fields where safe.
- Escape cancels.
- Show autosave status subtly.

### 10.3 Creation flows

Creation should be fast:
- “New” opens a small menu if multiple object types exist.
- Creating from a view should inherit context.
  - New task in Sales view defaults to Sales.
  - New SOP in branch view defaults to that branch visibility.
  - New task in an employee profile defaults to that employee.

### 10.4 Loading states

Use skeletons that match the final layout:
- Table skeleton rows.
- Board card skeletons.
- Sidebar nav skeleton if needed.
- AI response streaming text.

Avoid full-screen spinners except during initial app boot.

### 10.5 Empty states

Empty states should be calm and actionable.

Examples:
- “No tasks due today.”
- “This department has no SOPs yet.”
- “No employees match these filters.”

Include one primary action only when appropriate.

---

## 11. Accessibility

Minimum requirements:
- Text contrast at least WCAG AA.
- Visible keyboard focus for every interactive element.
- All icon-only buttons need labels/tooltips.
- Status must not rely on color alone; include text labels.
- Tables must support keyboard navigation and screen-reader labels.
- AI streaming content should be announced politely, not aggressively.
- Target size should be at least 40px for common controls and 44px on touch screens.

---

## 12. Iconography and Illustration

### 12.1 Icons

Use simple line icons with consistent stroke.

Rules:
- 16px icons in sidebar/table rows.
- 18-20px icons for page headers.
- Use filled emoji-like page icons sparingly.
- Icons should support scanning, not decorate every label.

### 12.2 Page icons

Notion-like page icons work well for Cendro:
- Dashboard: home/grid icon
- JD tasks: repeat/check icon
- One-time tasks: checkbox icon
- SOPs: document icon
- Company management: building icon
- Employees: users icon
- AI: simple face/spark icon

### 12.3 Illustration

Use illustration only for:
- Empty states
- Onboarding
- Marketing
- AI assistant identity

Keep illustrations small, playful, and secondary. Do not let them overpower operational screens.

---

## 13. Responsive Behavior

### Desktop
- Full sidebar.
- Main workspace flexible.
- AI panel can be open side-by-side.
- Tables and boards use horizontal scroll only when necessary.

### Tablet
- Sidebar collapses to icon rail or drawer.
- AI panel becomes overlay drawer.
- Board columns can horizontally scroll.

### Mobile
- Bottom navigation or drawer.
- AI becomes full-screen sheet.
- Tables become list cards.
- Primary actions move to sticky bottom or top-right.

---

## 14. Implementation Tokens

```css
:root {
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;

  --canvas: #ffffff;
  --canvas-soft: #f6f5f4;
  --surface: #ffffff;
  --surface-muted: #f7f7f5;
  --surface-pressed: #efefed;

  --ink: #0d0d0d;
  --ink-secondary: #31302e;
  --ink-muted: #615d59;
  --ink-faint: #a39e98;

  --hairline: #e6e6e6;
  --hairline-strong: #d9d9d6;

  --primary: #0075de;
  --primary-hover: #006ac8;
  --primary-pressed: #005bab;
  --on-primary: #ffffff;
  --focus-ring: #2383e2;

  --radius-xs: 4px;
  --radius-sm: 5px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  --space-0-5: 4px;
  --space-1: 8px;
  --space-1-5: 12px;
  --space-2: 16px;
  --space-3: 24px;
  --space-4: 32px;
  --space-5: 40px;
  --space-6: 48px;
}

[data-theme="dark"] {
  --canvas: #191919;
  --canvas-soft: #191919;
  --surface: #1f1f1f;
  --surface-muted: #252525;
  --surface-pressed: #2f2f2f;

  --ink: #f1f1f1;
  --ink-secondary: #d4d4d4;
  --ink-muted: #a8a8a8;
  --ink-faint: #6f6f6f;

  --hairline: #2f2f2f;
  --hairline-strong: #3a3a3a;

  --primary: #2383e2;
  --primary-hover: #2f8deb;
  --primary-pressed: #1a73c9;
  --on-primary: #ffffff;
  --focus-ring: #2383e2;
}
```

---

## 15. Do / Don't Summary

### Do
- Make Cendro feel like a calm internal workspace, not a colorful SaaS dashboard.
- Use warm paper surfaces, charcoal text, subtle borders, and one blue accent.
- Keep navigation dense and predictable.
- Use Notion-like page headers with icons, titles, descriptions, views, and toolbars.
- Use tables and boards as first-class database views.
- Keep the AI panel visually integrated and permission-aware.
- Prefer inline editing and optimistic updates.
- Use clear, direct product language.

### Don't
- Copy Notion logos, proprietary icons, or branded illustrations.
- Use many saturated colors in app chrome.
- Make every card elevated with shadows.
- Hide important operational data behind marketing-style visuals.
- Show actions the user's role cannot perform.
- Use vague AI responses when the user needs concrete tasks, SOPs, or people.
- Make permission errors sound technical or hostile.

---

## 16. North Star

Cendro should feel like this:

> A Notion-like operating system for a business: every task, SOP, employee, branch, department, and permission lives in a quiet, searchable workspace, with AI sitting beside the work as a helpful internal assistant.

If a design choice makes the app calmer, faster, clearer, and more document-like, it probably belongs. If it makes the app louder, more decorative, or harder to scan, remove it.
