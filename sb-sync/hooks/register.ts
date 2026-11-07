import type { EngineInterface, Register } from 'claude-code'

// Keeps each git project's page in SilverBullet in step with the work done on it.
//
// Mapping: the project's CLAUDE.md holds one line `SilverBullet: Projects/<Name>/`
// (the page is then `Projects/<Name>/<Name>.md`) or `SilverBullet: Projects/<Page>.md`.
// It travels with the repository, so it holds on every machine and OS.
//
// Automatic (end of turn, debounced; end of session): only mechanical fields —
// `last-activity:`, the commits block, the project's row in `Projects/Projets récents.md`.
// On command: `/sb-sync` (now), `/sb-sync new` (create the page, asks first),
// `/sb-refresh` (rewrite État actuel / Prochaines étapes, asks first).
//
// Safety: every write is a compare-and-swap (`If-Match` on the revision read),
// a 404 is the only "missing" (any other failure aborts), no empty or much shorter
// write, never a delete, never a page created without the person's yes.

const INDEX = 'Projects/Projets récents.md'
const DEBOUNCE_MS = 2 * 60 * 1000
const MODEL = 'sonnet'
const MIN_RATIO = 0.5

// Same markers as the former obsidian-sync, so existing pages keep their block.
export const COMMITS_START = '<!-- obsidian-sync:commits -->'
export const COMMITS_END = '<!-- /obsidian-sync:commits -->'

const SECRET =
  /(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,}|(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,})/i

type Creds = { url: string; cfId: string; cfSecret: string; token: string }
type Page = { text: string; rev: string }
type Report = { page: string; changed: string[]; notes: string[] }

class SbError extends Error {}
class Conflict extends Error {}

// ---------- pure helpers (exported for the tests) ----------

export function today(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseCreds(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m?.[1]) {
      continue
    }
    out[m[1]] = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }

  return out
}

// The SilverBullet page named by a `SilverBullet:` line, or undefined.
export function pageFromClaudeMd(text: string): string | undefined {
  const m = /^[ \t]*(?:[-*][ \t]+)?\**SilverBullet\**[ \t]*:[ \t]*`?([^`\n]+?)`?[ \t]*$/im.exec(text)
  const raw = m?.[1]?.trim()
  if (!raw || raw.startsWith('/') || !raw.startsWith('Projects/') || raw.split('/').includes('..')) {
    return undefined
  }
  if (raw.endsWith('.md')) {
    return raw
  }
  const folder = raw.replace(/\/+$/, '')
  const name = folder.split('/').pop() ?? ''

  return name ? `${folder}/${name}.md` : undefined
}

export function frontField(text: string, key: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const v = m && new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(m[1] ?? '')?.[1]

  return v ? v.trim().replace(/^["']|["']$/g, '') : undefined
}

export function setField(text: string, key: string, value: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) {
    return text
  }
  const head = m[1] ?? ''
  const re = new RegExp(`^${key}:.*$`, 'm')
  const body = re.test(head) ? head.replace(re, `${key}: ${value}`) : `${head}\n${key}: ${value}`

  return `---\n${body}\n---${text.slice(m[0].length)}`
}

export function blockTopHash(text: string): string | undefined {
  const start = text.indexOf(COMMITS_START)
  const end = text.indexOf(COMMITS_END)
  if (start === -1 || end < start) {
    return undefined
  }

  return /\(`([0-9a-f]{4,40})`\)/.exec(text.slice(start, end))?.[1]
}

export function commitsBlock(log: string): string | undefined {
  const lines = log
    .trim()
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => {
      const [date, hash, ...subject] = l.split('\t')
      return `- ${date} · ${subject.join('\t').trim()} (\`${hash}\`)`
    })

  return lines.length > 0 ? `${COMMITS_START}\n## Derniers commits\n${lines.join('\n')}\n${COMMITS_END}` : undefined
}

export function putBlock(text: string, block: string): string {
  const start = text.indexOf(COMMITS_START)
  const end = text.indexOf(COMMITS_END)
  if (start !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + COMMITS_END.length)
  }
  const links = text.search(/^## Liens\s*$/m)
  if (links !== -1) {
    return `${text.slice(0, links)}${block}\n\n${text.slice(links)}`
  }

  return `${text.trimEnd()}\n\n${block}\n`
}

// Splits a table row on `|`, leaving the `|` of `[[page|alias]]` links alone.
export function splitRow(row: string): string[] {
  const cells: string[] = []
  let cur = ''
  let depth = 0
  for (let i = 0; i < row.length; i++) {
    const two = row.slice(i, i + 2)
    if (two === '[[' || two === ']]') {
      depth += two === '[[' ? 1 : -1
      cur += two
      i++
      continue
    }
    const ch = row[i] ?? ''
    if (ch === '|' && depth <= 0) {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)

  return cells
}

const linkKey = (page: string) => page.replace(/\.md$/, '')

// Index table: sets the project's row date (never backwards), adds a row when
// `addSummary` is given and none exists, keeps rows newest first.
export function updateIndexText(
  text: string,
  page: string,
  date: string,
  addSummary?: string,
): { text: string; found: boolean } {
  const lines = text.split('\n')
  const sep = lines.findIndex(l => /^\|\s*:?-+:?\s*\|/.test(l))
  if (sep === -1) {
    return { text, found: false }
  }
  let end = sep + 1
  while (end < lines.length && (lines[end] ?? '').startsWith('|')) {
    end++
  }
  const rows = lines.slice(sep + 1, end)
  const key = linkKey(page)
  const i = rows.findIndex(r => {
    const first = splitRow(r)[1] ?? ''
    return first.includes(`[[${key}]]`) || first.includes(`[[${key}|`)
  })
  if (i === -1 && addSummary === undefined) {
    return { text, found: false }
  }
  if (i === -1) {
    rows.push(`| [[${key}]] | en cours | ${(addSummary ?? '').replace(/\|/g, '/')} | ${date} |`)
  } else {
    const cells = splitRow(rows[i] ?? '')
    if (cells.length >= 6 && (cells[4] ?? '').trim() < date) {
      cells[4] = ` ${date} `
      rows[i] = cells.join('|')
    }
  }
  const dateOf = (r: string) => splitRow(r)[4]?.trim() ?? ''
  rows.sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
  const next = [...lines.slice(0, sep + 1), ...rows, ...lines.slice(end)].join('\n')

  return { text: next === text ? text : setField(next, 'updated', date), found: true }
}

export function firstSentence(note: string): string | undefined {
  const m = /## Résumé\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(note)
  const line = (m?.[1] ?? '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '' && !l.startsWith('#'))
  if (!line) {
    return undefined
  }

  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

export function replaceSection(text: string, heading: string, body: string): string {
  const marker = COMMITS_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^## ${heading}\\s*\\n[\\s\\S]*?(?=^## |^${marker}|(?![\\s\\S]))`, 'm')

  return re.test(text) ? text.replace(re, `## ${heading}\n${body.trim()}\n\n`) : text
}

// Refuses a write that would empty or gut a page.
export function guardWrite(next: string, base: string | undefined): string | undefined {
  if (next.trim() === '') {
    return 'empty content'
  }
  if (base !== undefined && next.length < base.length * MIN_RATIO) {
    return `new content much shorter than the page (${next.length} < ${Math.round(MIN_RATIO * 100)}% of ${base.length})`
  }

  return undefined
}

// ---------- SilverBullet client ----------

let credsCache: Creds | undefined

async function creds($: EngineInterface): Promise<Creds> {
  if (credsCache) {
    return credsCache
  }
  const override = await $.env.get('SB_CREDENTIALS')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const path = override || (home ? `${home.replace(/\\/g, '/')}/.config/sb/credentials` : '')
  let text: string
  try {
    text = (await $.fs.read(path)) as string
  } catch {
    throw new SbError(`credentials file not found (${path || 'no HOME'})`)
  }
  const kv = parseCreds(text)
  const { SB_URL, CF_ID, CF_SECRET, SB_TOKEN } = kv
  if (!SB_URL || !CF_ID || !CF_SECRET || !SB_TOKEN) {
    throw new SbError('credentials file lacks SB_URL, CF_ID, CF_SECRET or SB_TOKEN')
  }
  credsCache = { url: SB_URL.replace(/\/+$/, ''), cfId: CF_ID, cfSecret: CF_SECRET, token: SB_TOKEN }

  return credsCache
}

function pageUrl(c: Creds, path: string): string {
  return `${c.url}/.fs/${path.split('/').map(encodeURIComponent).join('/')}`
}

function authHeaders(c: Creds): Record<string, string> {
  return {
    'CF-Access-Client-Id': c.cfId,
    'CF-Access-Client-Secret': c.cfSecret,
    Authorization: `Bearer ${c.token}`,
    'X-Sync-Mode': 'true',
  }
}

// The page and its revision; undefined only on a 404. Anything else throws.
async function sbGet($: EngineInterface, path: string): Promise<Page | undefined> {
  const c = await creds($)
  const r = await $.http.fetch(pageUrl(c, path), { headers: authHeaders(c) })
  if (r.status === 404) {
    return undefined
  }
  if (r.status !== 200) {
    throw new SbError(`GET ${path}: HTTP ${r.status}`)
  }
  const rev = r.headers['x-silverbullet-revision'] ?? r.headers['etag']?.replace(/^W\//, '')
  if (!rev || r.headers['x-permission'] === undefined) {
    // A Cloudflare login page answers 200 too: never take it for the page.
    throw new SbError(`GET ${path}: not a SilverBullet answer (authentication?)`)
  }

  return { text: r.text, rev }
}

// Writes `text` over `base` (If-Match) or as a new page ('new': must be absent).
async function sbPut($: EngineInterface, path: string, text: string, base: Page | 'new'): Promise<void> {
  const refused = guardWrite(text, base === 'new' ? undefined : base.text)
  if (refused) {
    throw new SbError(`write refused for ${path}: ${refused}`)
  }
  if (base === 'new' && (await sbGet($, path)) !== undefined) {
    throw new Conflict(`${path} already exists`)
  }
  const c = await creds($)
  const r = await $.http.fetch(pageUrl(c, path), {
    method: 'PUT',
    headers: {
      ...authHeaders(c),
      'Content-Type': 'text/markdown',
      ...(base === 'new' ? { 'If-None-Match': '*' } : { 'If-Match': base.rev }),
    },
    body: text,
  })
  if (r.status === 412) {
    throw new Conflict(`${path} changed in SilverBullet since it was read`)
  }
  if (!r.ok) {
    throw new SbError(`PUT ${path}: HTTP ${r.status}`)
  }
}

// ---------- git and mapping ----------

async function git($: EngineInterface, repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(['git', '-C', repo, ...args], { timeoutMs: 20000 })
    return { ok: r.exitCode === 0, out: r.stdout }
  } catch {
    return { ok: false, out: '' }
  }
}

async function repoRoot($: EngineInterface): Promise<string | undefined> {
  const r = await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel'])
  const root = r.out.trim()

  return r.ok && root ? root : undefined
}

async function mappedPage($: EngineInterface, repo: string): Promise<string | undefined> {
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    try {
      const page = pageFromClaudeMd((await $.fs.read(`${repo}/${f}`)) as string)
      if (page) {
        return page
      }
    } catch {
      // no such file
    }
  }

  return undefined
}

// ---------- mechanical sync ----------

async function updateIndexRow($: EngineInterface, page: string, date: string, report: Report, addSummary?: string) {
  const idx = await sbGet($, INDEX)
  if (!idx) {
    return
  }
  const { text, found } = updateIndexText(idx.text, page, date, addSummary)
  if (!found) {
    report.notes.push(`no row for it in ${INDEX}`)
  } else if (text !== idx.text) {
    await sbPut($, INDEX, text, idx)
    report.changed.push('index')
  }
}

const lastRun = new Map<string, number>()
let running = false

async function sync($: EngineInterface, force: boolean): Promise<Report | undefined> {
  const repo = await repoRoot($)
  if (!repo) {
    return undefined
  }
  const page = await mappedPage($, repo)
  if (!page) {
    return undefined
  }
  const now = Date.now()
  if ((!force && now - (lastRun.get(repo) ?? 0) < DEBOUNCE_MS) || running) {
    return undefined
  }
  running = true
  lastRun.set(repo, now)
  const report: Report = { page, changed: [], notes: [] }
  try {
    const note = await sbGet($, page)
    if (!note) {
      report.notes.push('page missing in SilverBullet: /sb-sync new to create it')
      return report
    }
    const date = today()
    let next = note.text
    const last = frontField(next, 'last-activity')
    if (!last || last < date) {
      next = setField(next, 'last-activity', date)
    }
    const log = await git($, repo, ['log', '-5', '--format=%cs%x09%h%x09%s'])
    const block = log.ok ? commitsBlock(log.out) : undefined
    if (block) {
      const pageTop = blockTopHash(next)
      // A clone that is behind (or diverged) must not roll the block back.
      const ahead = !pageTop || (await git($, repo, ['merge-base', '--is-ancestor', pageTop, 'HEAD'])).ok
      if (ahead) {
        next = putBlock(next, block)
      } else {
        report.notes.push(`commits block kept: ${pageTop} is not in this clone's history (pull first?)`)
      }
    }
    if (next !== note.text) {
      await sbPut($, page, next, note)
      report.changed.push('note')
    }
    await updateIndexRow($, page, date, report)

    return report
  } finally {
    running = false
  }
}

function describe(r: Report): string | undefined {
  const parts = [...(r.changed.length > 0 ? [`updated ${r.changed.join(' + ')}`] : []), ...r.notes]

  return parts.length > 0 ? `${r.page}: ${parts.join('; ')}` : undefined
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// What the background path already showed this session: each note or error
// toasts once, changes every time.
const shown = new Set<string>()

export function backgroundToast(r: Report, seen: Set<string> = shown): string | undefined {
  const fresh = r.notes.filter(n => !seen.has(`${r.page}\n${n}`))
  for (const n of fresh) {
    seen.add(`${r.page}\n${n}`)
  }

  return describe({ ...r, notes: fresh })
}

function runInBackground($: EngineInterface) {
  $.clock.after(0, () => {
    sync($, false).then(
      r => {
        const text = r && backgroundToast(r)
        if (text) {
          $.ui.toast(text)
        }
      },
      (err: unknown) => {
        const msg = errorText(err)
        $.ui.log(`sb-sync: ${msg}`, { to: 'debug' })
        if (!shown.has(msg)) {
          shown.add(msg)
          $.ui.toast(`sb-sync: ${msg}`)
        }
      },
    )
  })
}

// ---------- /sb-sync new ----------

const NOTE_SYSTEM = `You write a project note for a SilverBullet space, in French, from a git repository's own files.

Output only the note, as Markdown, no code fence, in exactly this shape:

---
type: Project
status: en cours
project-fields:
  - <2 to 4 lowercase kebab-case fields, e.g. audio-plugin, website, web-app, tooling>
tech-stack:
  - <main languages, frameworks and services>
last-activity: <given>
---
# <given name>

## Résumé
<2 to 4 sentences: what the project is and does>

## État actuel
<bullets: where the work stands, from the commits and docs>

## Prochaines étapes connues
<bullets, only what the files state; "- À définir." when nothing does>

## Liens
- Dépôt : \`<given repo>\`

Rules: never invent facts; never copy keys, tokens, passwords, serial numbers or private hostnames.`

async function readHead($: EngineInterface, path: string, max: number): Promise<string> {
  try {
    return ((await $.fs.read(path)) as string).slice(0, max)
  } catch {
    return ''
  }
}

async function ask($: EngineInterface, question: string, options: string[]): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, options)
  } catch {
    return undefined
  }
}

async function createPage($: EngineInterface): Promise<string> {
  const repo = await repoRoot($)
  if (!repo) {
    return 'Not in a git repository: nothing created.'
  }
  const base = repo.split('/').pop() ?? ''
  let page = await mappedPage($, repo)
  const hadLine = page !== undefined
  if (!page) {
    const suggested = `Projects/${base}/`
    const answer = await ask($, `Dossier SilverBullet pour ${base} ? (Other : saisis un autre chemin Projects/…)`, [
      suggested,
      'Annuler',
    ])
    if (!answer || answer === 'Annuler') {
      return 'Cancelled: nothing created.'
    }
    page = pageFromClaudeMd(`SilverBullet: ${answer}`)
    if (!page) {
      return `"${answer}" is not a path under Projects/: nothing created.`
    }
  }
  if ((await sbGet($, page)) !== undefined) {
    return hadLine
      ? `${page} already exists: nothing to create (/sb-sync to update it).`
      : `${page} already exists: add the line \`SilverBullet: ${page.replace(/[^/]+\.md$/, '')}\` to this project's CLAUDE.md to link it.`
  }
  const name = (page.split('/').pop() ?? base).replace(/\.md$/, '')
  const remote = (await git($, repo, ['remote', 'get-url', 'origin'])).out.trim()
  const repoRef = remote.replace(/^https?:\/\/github\.com\/|^git@github\.com:/, '').replace(/\.git$/, '') || base
  const date = today()
  const parts: [string, string][] = [
    ['CLAUDE.md', await readHead($, `${repo}/CLAUDE.md`, 4000)],
    ['CONTEXT.md', await readHead($, `${repo}/CONTEXT.md`, 3000)],
    ['README.md', await readHead($, `${repo}/README.md`, 3000)],
    ['git log', (await git($, repo, ['log', '-15', '--format=%cs %s'])).out],
    ['top-level files', (await git($, repo, ['ls-files', '--', ':(glob)*'])).out.slice(0, 2000)],
  ]
  const docs = parts
    .filter(([, t]) => t.trim() !== '')
    .map(([title, t]) => `## ${title}\n${t}`)
    .join('\n\n')
  $.ui.status('sb-sync: drafting the page…')
  let note: string | undefined
  try {
    const r = await $.model.complete({
      model: MODEL,
      system: NOTE_SYSTEM,
      prompt: `Name: ${name}\nrepo: ${repoRef}\nlast-activity: ${date}\n\n<repository>\n${docs}\n</repository>`,
      maxTokens: 2048,
      effort: 'low',
      timeoutMs: 60000,
    })
    if (r.isAnswered && r.text.trim().startsWith('---')) {
      note = r.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')
    }
  } catch {
    // skeleton below
  } finally {
    $.ui.status(undefined)
  }
  note ??= `---\ntype: Project\nstatus: en cours\nproject-fields: []\ntech-stack: []\nlast-activity: ${date}\n---\n# ${name}\n\n## Résumé\n\n## État actuel\n\n## Prochaines étapes connues\n\n## Liens\n- Dépôt : \`${repoRef}\`\n`
  note = `${setField(note, 'last-activity', date).trimEnd()}\n`
  if (SECRET.test(note)) {
    return 'The draft looks like it holds a secret: nothing created.'
  }
  $.ui.log(`sb-sync — brouillon de ${page} :\n\n${note}`)
  const yes = await ask($, `Créer ${page} avec ce brouillon et l'ajouter à l'index ?`, ['Créer', 'Annuler'])
  if (yes !== 'Créer') {
    return 'Cancelled: nothing created.'
  }
  await sbPut($, page, note, 'new')
  const report: Report = { page, changed: ['created'], notes: [] }
  try {
    await updateIndexRow($, page, date, report, firstSentence(note) ?? '')
  } catch (err) {
    report.notes.push(`index not updated: ${errorText(err)}`)
  }
  if (!hadLine) {
    const line = `SilverBullet: ${page.endsWith(`${name}/${name}.md`) ? page.replace(/[^/]+\.md$/, '') : page}`
    const add = await ask($, `Ajouter la ligne « ${line} » au CLAUDE.md du dépôt ?`, ['Ajouter', 'Non'])
    if (add === 'Ajouter') {
      const path = `${repo}/CLAUDE.md`
      const current = await readHead($, path, Number.MAX_SAFE_INTEGER)
      await $.fs.write(path, current ? `${current.trimEnd()}\n\n${line}\n` : `${line}\n`)
      report.changed.push('CLAUDE.md')
    } else {
      report.notes.push(`add \`${line}\` to CLAUDE.md to keep it synced`)
    }
  }

  return describe(report) ?? `${page}: created.`
}

// ---------- /sb-refresh ----------

const REFRESH_PROMPT = (note: string) => `Update the project note below (a SilverBullet page), from what this conversation did on the project.

Rewrite only two sections, in French, as concise bullets: "## État actuel" (where the work stands now) and "## Prochaines étapes connues" (what remains, only what was stated or decided; "- À définir." if nothing). Keep what is still true from the current text, drop what is outdated. Never copy keys, tokens, passwords, serial numbers or private hostnames.

Answer with exactly those two sections, headings included, nothing else, no code fence.

<note>
${note}
</note>`

async function refresh($: EngineInterface): Promise<string> {
  const repo = await repoRoot($)
  const page = repo && (await mappedPage($, repo))
  if (!page) {
    return 'No `SilverBullet:` line in this project\'s CLAUDE.md: run /sb-sync new first.'
  }
  const note = await sbGet($, page)
  if (!note) {
    return `${page} is missing in SilverBullet: run /sb-sync new first.`
  }
  $.ui.status('sb-refresh: drafting…')
  let out: string
  try {
    const r = await $.model.fork({ prompt: REFRESH_PROMPT(note.text) })
    if (!r.isAnswered) {
      return `Page not updated: ${r.reason}.`
    }
    out = r.text.trim()
  } finally {
    $.ui.status(undefined)
  }
  const etat = /## État actuel\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(out)?.[1]
  const steps = /## Prochaines étapes connues\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(out)?.[1]
  if (!etat || !steps) {
    return 'Page not updated: the answer did not hold both sections.'
  }
  const proposal = `## État actuel\n${etat.trim()}\n\n## Prochaines étapes connues\n${steps.trim()}`
  if (SECRET.test(proposal)) {
    return 'Page not updated: the proposal looks like it holds a secret.'
  }
  let updated = replaceSection(replaceSection(note.text, 'État actuel', etat), 'Prochaines étapes connues', steps)
  if (updated === note.text) {
    return `${page}: the page has no such sections, or nothing changed.`
  }
  const last = frontField(updated, 'last-activity')
  if (!last || last < today()) {
    updated = setField(updated, 'last-activity', today())
  }
  $.ui.log(`sb-refresh — proposition pour ${page} :\n\n${proposal}`)
  const yes = await ask($, `Écrire ces deux sections dans ${page} ?`, ['Écrire', 'Annuler'])
  if (yes !== 'Écrire') {
    return 'Cancelled: page unchanged.'
  }
  try {
    await sbPut($, page, updated, note)
  } catch (err) {
    if (err instanceof Conflict) {
      return `${page} changed in SilverBullet meanwhile: nothing written. Run /sb-refresh again.`
    }
    throw err
  }

  return `${page}: État actuel and Prochaines étapes updated.`
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sb-sync',
      description: 'Sync this project into SilverBullet now; "/sb-sync new" creates its page (asks first)',
    })
    await $.command.register({
      name: 'sb-refresh',
      description: "Rewrite this project's État actuel and Prochaines étapes in SilverBullet (asks first)",
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    runInBackground($)

    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      await sync($, true)
    } catch {
      // best effort at exit
    }

    return next(e)
  })

  on('command.run', { command: 'sb-sync' }, async ($, e) => {
    try {
      if ((e.args ?? '').trim() === 'new') {
        return { text: await createPage($) }
      }
      const repo = await repoRoot($)
      if (!repo) {
        return { text: 'Not in a git repository: nothing synced.' }
      }
      if (!(await mappedPage($, repo))) {
        return {
          text: 'No `SilverBullet: Projects/<Name>/` line in this project\'s CLAUDE.md: add one, or run /sb-sync new.',
        }
      }
      const r = await sync($, true)
      if (!r) {
        return { text: 'A sync is already running: try again in a moment.' }
      }

      return { text: describe(r) ?? `${r.page}: up to date.` }
    } catch (err) {
      return { text: `sb-sync: ${errorText(err)}` }
    }
  })

  on('command.run', { command: 'sb-refresh' }, async $ => {
    try {
      return { text: await refresh($) }
    } catch (err) {
      return { text: `sb-refresh: ${errorText(err)}` }
    }
  })
}
