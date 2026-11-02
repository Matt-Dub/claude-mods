import type { EngineInterface, Register } from 'claude-code'

// Keeps the Obsidian "Projects" vault in step with the git projects worked on.
// Each project is a folder `<vault>/<Name>/` holding the project note
// `<Name>.md` (frontmatter `repo:` points at the repository) and mirrored
// copies of the repository's Markdown files under `Fichiers du dépôt/`.

// Set from the `vaultPath` plugin option in `register`. Empty: the mod stays idle.
let VAULT = ''
const NO_VAULT = 'obsidian-sync: set the vault folder in the plugin option vaultPath (/config).'
const indexPath = () => `${VAULT}/Projets récents.md`
const COPIES = 'Fichiers du dépôt'
const DEBOUNCE_MS = 2 * 60 * 1000
const MAX_FILES_WITHOUT_INCLUDE = 200
const MODEL = 'sonnet'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'build', '.next', 'coverage', '.venv', 'docs-bak', 'graphify-out', '.agents', '.impeccable',
])
const SKIP_PREFIX = /^\.claude\/(skills|agents|commands)\//
const SECRET =
  /(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,}|(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,})/i

const COMMITS_START = '<!-- obsidian-sync:commits -->'
const COMMITS_END = '<!-- /obsidian-sync:commits -->'

type Project = { name: string; note: string; repo: string; include: string[] | undefined }
type Report = { name: string; copied: number; secrets: string[]; created: boolean; noteChanged: boolean; note?: string }

const lastRun = new Map<string, number>()
let running = false

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function git($: EngineInterface, repo: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', '-C', repo, ...args], { timeoutMs: 20000 })

    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

async function repoRoot($: EngineInterface, dir: string): Promise<string | undefined> {
  const out = await git($, dir, ['rev-parse', '--show-toplevel'])
  const root = out?.trim()
  if (!root || root === VAULT || root.startsWith(`${VAULT}/`)) {
    return undefined
  }

  return root
}

// Reads `key: value` and `key:\n  - item` lists from a note's frontmatter.
function frontmatter(text: string): Map<string, string | string[]> {
  const fm = new Map<string, string | string[]>()
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) {
    return fm
  }
  let listKey: string | undefined
  for (const line of (m[1] ?? '').split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item?.[1] !== undefined && listKey) {
      ;(fm.get(listKey) as string[]).push(item[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    const k = kv?.[1]
    if (k === undefined) {
      continue
    }
    const value = (kv?.[2] ?? '').trim()
    if (value === '') {
      listKey = k
      fm.set(k, [])
    } else {
      listKey = undefined
      fm.set(k, value.replace(/^["']|["']$/g, ''))
    }
  }

  return fm
}

async function projects($: EngineInterface): Promise<Project[]> {
  const out: Project[] = []
  let entries
  try {
    entries = await $.fs.list(VAULT)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) {
      continue
    }
    const note = `${VAULT}/${entry.name}/${entry.name}.md`
    let text: string
    try {
      text = (await $.fs.read(note)) as string
    } catch {
      continue
    }
    const fm = frontmatter(text)
    const repo = fm.get('repo')
    if (typeof repo !== 'string' || repo === '') {
      continue
    }
    const inc = fm.get('sync-include')
    out.push({ name: entry.name, note, repo: repo.replace(/\/+$/, ''), include: Array.isArray(inc) && inc.length > 0 ? inc : undefined })
  }

  return out
}

async function markdownFiles($: EngineInterface, repo: string, include: string[] | undefined): Promise<string[]> {
  if (include) {
    return include
  }
  const out = await git($, repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'])
  if (out === undefined) {
    return []
  }
  const seen = new Set<string>()
  for (const rel of out.split('\0')) {
    if (!rel || seen.has(rel)) {
      continue
    }
    if (SKIP_PREFIX.test(rel) || rel.split('/').some(part => SKIP_DIRS.has(part))) {
      continue
    }
    seen.add(rel)
  }

  return [...seen]
}

async function mtime($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

// Mirrors each Markdown file whose source is newer than its copy.
async function copyFiles($: EngineInterface, p: Project, files: string[], report: Report) {
  for (const rel of files) {
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      continue
    }
    const src = `${p.repo}/${rel}`
    const dst = `${VAULT}/${p.name}/${COPIES}/${rel}`
    const srcTime = await mtime($, src)
    if (srcTime === undefined) {
      continue
    }
    const dstTime = await mtime($, dst)
    if (dstTime !== undefined && dstTime >= srcTime) {
      continue
    }
    let text: string
    try {
      text = (await $.fs.read(src)) as string
    } catch {
      continue
    }
    if (SECRET.test(text)) {
      report.secrets.push(rel)
      continue
    }
    if (dstTime !== undefined) {
      try {
        if (((await $.fs.read(dst)) as string) === text) {
          continue
        }
      } catch {
        // unreadable copy: overwrite it
      }
    }
    await $.fs.write(dst, text)
    report.copied++
  }
}

function setField(text: string, key: string, value: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) {
    return text
  }
  const head = m[1] ?? ''
  const re = new RegExp(`^${key}:.*$`, 'm')
  const body = re.test(head) ? head.replace(re, `${key}: ${value}`) : `${head}\n${key}: ${value}`

  return `---\n${body}\n---${text.slice(m[0].length)}`
}

async function commitsBlock($: EngineInterface, repo: string): Promise<string | undefined> {
  const log = await git($, repo, ['log', '-5', '--format=%cs%x09%h%x09%s'])
  if (log === undefined || log.trim() === '') {
    return undefined
  }
  const lines = log
    .trim()
    .split('\n')
    .map(l => {
      const [date, hash, ...subject] = l.split('\t')
      return `- ${date} · ${subject.join('\t').trim()} (\`${hash}\`)`
    })

  return `${COMMITS_START}\n## Derniers commits\n${lines.join('\n')}\n${COMMITS_END}`
}

function putBlock(text: string, block: string): string {
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

async function updateNote($: EngineInterface, p: Project, report: Report) {
  let text: string
  try {
    text = (await $.fs.read(p.note)) as string
  } catch {
    return
  }
  let next = setField(text, 'last-activity', today())
  const block = await commitsBlock($, p.repo)
  if (block) {
    next = putBlock(next, block)
  }
  if (next !== text) {
    await $.fs.write(p.note, next)
    report.noteChanged = true
  }
}

// Updates (or adds) the project's row in the index table and keeps the rows
// sorted by last activity, newest first.
async function updateIndex($: EngineInterface, p: Project, summary: string | undefined) {
  let text: string
  try {
    text = (await $.fs.read(indexPath())) as string
  } catch {
    return
  }
  const lines = text.split('\n')
  const sep = lines.findIndex(l => /^\|\s*-+\s*\|/.test(l))
  if (sep === -1) {
    return
  }
  let end = sep + 1
  while (end < lines.length && (lines[end] ?? '').startsWith('|')) {
    end++
  }
  const rows = lines.slice(sep + 1, end)
  const date = today()
  const key = `| [[${p.name}]] |`
  const i = rows.findIndex(r => r.startsWith(key))
  if (i === -1) {
    rows.push(`| [[${p.name}]] | en cours | ${(summary ?? '').replace(/\|/g, '/')} | ${date} |`)
  } else {
    const cells = (rows[i] ?? '').split('|')
    if (cells.length >= 6) {
      cells[4] = ` ${date} `
      rows[i] = cells.join('|')
    }
  }
  const dateOf = (r: string) => r.split('|')[4]?.trim() ?? ''
  rows.sort((a, b) => dateOf(b).localeCompare(dateOf(a)))
  const next = [...lines.slice(0, sep + 1), ...rows, ...lines.slice(end)].join('\n')
  if (next !== text) {
    await $.fs.write(indexPath(), setField(next, 'updated', date))
  }
}

async function readHead($: EngineInterface, path: string, max: number): Promise<string> {
  try {
    return ((await $.fs.read(path)) as string).slice(0, max)
  } catch {
    return ''
  }
}

const NOTE_SYSTEM = `You write a project note for an Obsidian vault, in French, from a git repository's own files.

Output only the note, as Markdown, no code fence, in exactly this shape:

---
type: Project
status: en cours
project-fields:
  - <2 to 4 lowercase kebab-case fields, e.g. audio-plugin, website, web-app, tooling>
tech-stack:
  - <main languages, frameworks and services>
repo: <given>
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
- Dépôt : \`<given repo path>\`

Rules: never invent facts; never copy keys, tokens, passwords, serial numbers or private hostnames.`

async function createProject($: EngineInterface, repo: string, existing: Project[]): Promise<Project | undefined> {
  const name = repo.split('/').pop() ?? ''
  if (!name || name.startsWith('.') || existing.some(p => p.name === name)) {
    return undefined
  }
  if (await $.fs.exists(`${VAULT}/${name}`)) {
    $.ui.toast(`"${name}" exists in the vault without a repo: field; add repo: ${repo} to its note to link it`)
    return undefined
  }
  const date = today()
  const parts: [string, string][] = [
    ['CLAUDE.md', await readHead($, `${repo}/CLAUDE.md`, 4000)],
    ['CONTEXT.md', await readHead($, `${repo}/CONTEXT.md`, 3000)],
    ['README.md', await readHead($, `${repo}/README.md`, 3000)],
    ['git log', (await git($, repo, ['log', '-15', '--format=%cs %s'])) ?? ''],
    ['top-level files', ((await git($, repo, ['ls-files', '--', ':(glob)*'])) ?? '').slice(0, 2000)],
  ]
  const docs = parts
    .filter(([, text]) => text.trim() !== '')
    .map(([title, text]) => `## ${title}\n${text}`)
    .join('\n\n')
  let note: string | undefined
  try {
    const r = await $.model.complete({
      model: MODEL,
      system: NOTE_SYSTEM,
      prompt: `Name: ${name}\nrepo: ${repo}\nlast-activity: ${date}\n\n<repository>\n${docs}\n</repository>`,
      maxTokens: 2048,
      effort: 'low',
      timeoutMs: 60000,
    })
    if (r.isAnswered && r.text.trim().startsWith('---')) {
      note = r.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')
    }
  } catch {
    // fall back to the skeleton below
  }
  note ??= `---\ntype: Project\nstatus: en cours\nproject-fields: []\ntech-stack: []\nrepo: ${repo}\nlast-activity: ${date}\n---\n# ${name}\n\n## Résumé\n\n## État actuel\n\n## Prochaines étapes connues\n\n## Liens\n- Dépôt : \`${repo}\`\n`
  note = setField(setField(note, 'repo', repo), 'last-activity', date)
  const path = `${VAULT}/${name}/${name}.md`
  await $.fs.write(path, `${note.trimEnd()}\n`)

  return { name, note: path, repo, include: undefined }
}

function firstSentence(note: string): string | undefined {
  const m = /## Résumé\s*\n+([^\n]+)/.exec(note)
  const s = m?.[1]?.trim()
  if (!s) {
    return undefined
  }

  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}

async function sync($: EngineInterface, force: boolean): Promise<Report | undefined> {
  if (!VAULT) {
    return undefined
  }
  const repo = await repoRoot($, await $.session.cwd())
  if (!repo) {
    return undefined
  }
  const now = Date.now()
  if (!force && now - (lastRun.get(repo) ?? 0) < DEBOUNCE_MS) {
    return undefined
  }
  if (running) {
    return undefined
  }
  running = true
  lastRun.set(repo, now)
  try {
    const all = await projects($)
    let p = all.find(x => x.repo === repo)
    const report: Report = { name: '', copied: 0, secrets: [], created: false, noteChanged: false }
    if (!p) {
      p = await createProject($, repo, all)
      if (!p) {
        return undefined
      }
      report.created = true
    }
    report.name = p.name
    const files = await markdownFiles($, p.repo, p.include)
    if (!p.include && files.length > MAX_FILES_WITHOUT_INCLUDE) {
      report.note = `${files.length} Markdown files: none copied; list the ones to keep under sync-include: in the note`
    } else {
      await copyFiles($, p, files, report)
    }
    await updateNote($, p, report)
    let summary: string | undefined
    if (report.created) {
      summary = firstSentence((await $.fs.read(p.note)) as string)
    }
    await updateIndex($, p, summary)

    return report
  } finally {
    running = false
  }
}

function describe(r: Report): string | undefined {
  const parts: string[] = []
  if (r.created) {
    parts.push('new project folder')
  }
  if (r.noteChanged && !r.created) {
    parts.push('note updated')
  }
  if (r.copied > 0) {
    parts.push(`${r.copied} file${r.copied > 1 ? 's' : ''} copied`)
  }
  if (r.secrets.length > 0) {
    parts.push(`skipped (looks like a secret): ${r.secrets.join(', ')}`)
  }
  if (r.note) {
    parts.push(r.note)
  }

  return parts.length > 0 ? `${r.name}: ${parts.join('; ')}` : undefined
}

function runInBackground($: EngineInterface, force: boolean) {
  $.clock.after(0, () => {
    sync($, force).then(
      r => {
        const text = r && describe(r)
        if (text) {
          $.ui.toast(text)
        }
      },
      (err: unknown) => $.ui.log(`obsidian-sync failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }),
    )
  })
}

const REFRESH_PROMPT = (note: string) => `Update the project note below for the Obsidian vault, from what this conversation did on the project.

Rewrite only two sections, in French, as concise bullets: "## État actuel" (where the work stands now) and "## Prochaines étapes connues" (what remains, only what was stated or decided; "- À définir." if nothing). Keep what is still true from the current text, drop what is outdated. Never copy keys, tokens, passwords, serial numbers or private hostnames.

Answer with exactly those two sections, headings included, nothing else, no code fence.

<note>
${note}
</note>`

function replaceSection(text: string, heading: string, body: string): string {
  const re = new RegExp(`^## ${heading}\\s*\\n[\\s\\S]*?(?=^## |^${COMMITS_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|(?![\\s\\S]))`, 'm')
  const section = `## ${heading}\n${body.trim()}\n\n`

  return re.test(text) ? text.replace(re, section) : text
}

export const register: Register = (on, options) => {
  const vaultPath = options.vaultPath
  VAULT = typeof vaultPath === 'string' ? vaultPath.trim().replace(/\/+$/, '') : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vault-sync',
      description: 'Sync this git project into the Obsidian vault now',
    })
    await $.command.register({
      name: 'vault-refresh',
      description: "Rewrite this project's État actuel and Prochaines étapes in Obsidian from the conversation",
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    runInBackground($, false)

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

  on('command.run', { command: 'vault-sync' }, async $ => {
    if (!VAULT) {
      return { text: NO_VAULT }
    }
    const r = await sync($, true)
    if (!r) {
      return { text: 'Not in a git repository (or a sync is already running): nothing synced.' }
    }

    return { text: describe(r) ?? `${r.name}: up to date.` }
  })

  on('command.run', { command: 'vault-refresh' }, async $ => {
    if (!VAULT) {
      return { text: NO_VAULT }
    }
    const repo = await repoRoot($, await $.session.cwd())
    const p = repo ? (await projects($)).find(x => x.repo === repo) : undefined
    if (!p) {
      return { text: 'No vault note for this project yet: run /vault-sync first (in a git repository).' }
    }
    const note = (await $.fs.read(p.note)) as string
    $.ui.status('vault-refresh: updating the note…')
    try {
      const r = await $.model.fork({ prompt: REFRESH_PROMPT(note) })
      if (!r.isAnswered) {
        return { text: `Note not updated: ${r.reason}.` }
      }
      const out = r.text.trim()
      const etat = /## État actuel\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(out)?.[1]
      const next = /## Prochaines étapes connues\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(out)?.[1]
      if (!etat || !next) {
        return { text: 'Note not updated: the answer did not hold both sections.' }
      }
      const updated = setField(
        replaceSection(replaceSection(note, 'État actuel', etat), 'Prochaines étapes connues', next),
        'last-activity',
        today(),
      )
      await $.fs.write(p.note, updated)

      return { text: `Updated ${p.note}:\n\n## État actuel\n${etat.trim()}\n\n## Prochaines étapes connues\n${next.trim()}` }
    } finally {
      $.ui.status(undefined)
    }
  })
}
