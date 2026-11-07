import { expect, test } from 'claude-code/testing'
import { COMMITS_END, COMMITS_START } from '../hooks/register'

// A fake SilverBullet .fs API, a fake git, a fake disk: the hooks below stand
// for the engine, so nothing leaves the test.

type Store = Map<string, { text: string; rev: number }>
type Opts = {
  store: Store
  ancestor?: boolean
  beforePut?: (path: string, store: Store) => void
  getStatus?: number
  loginPage?: boolean
}

const NOTE = 'Projects/BassTone X/BassTone X.md'
const INDEX_PATH = 'Projects/Projets récents.md'
const BASE = 'https://sb.test'

const note = (block: string) => `---
type: Project
last-activity: 2026-11-01
---
# BassTone X

## Résumé
Un synthé de basse.

${COMMITS_START}
## Derniers commits
${block}
${COMMITS_END}

## Liens
- Framework : [[Projects/HISE Fork/HISE Fork|HISE Fork]]
`

const INDEX = `---
type: Index
updated: 2026-11-04
---
# Projets récents

| Projet | Statut | Résumé | Dernière activité |
|---|---|---|---|
| [[Projects/Email Responder/Email Responder]] | en cours | File | 2026-11-04 |
| [[Projects/BassTone X/BassTone X]] | en cours | Synthé | 2026-11-01 |
`

function seed(): Store {
  return new Map([
    [NOTE, { text: note('- 2026-11-01 · Old (`aaa1111`)'), rev: 1 }],
    [INDEX_PATH, { text: INDEX, rev: 1 }],
  ])
}

function engine(on: Parameters<Parameters<typeof test>[1]>[1], o: Opts) {
  const puts: string[] = []
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.config/sb/credentials') {
      return { value: `SB_URL=${BASE}\nCF_ID=id\nCF_SECRET=secret\nSB_TOKEN=tok\n` }
    }
    if (e.path === '/repo/CLAUDE.md') {
      return { value: '# Repo\n\nSilverBullet: Projects/BassTone X/\n' }
    }
    return { deny: 'ENOENT' }
  })
  on('process.run', (_, e) => {
    const a = e.argv.slice(3).join(' ')
    if (a.startsWith('rev-parse')) {
      return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } }
    }
    if (a.startsWith('log -5')) {
      return { value: { exitCode: 0, stdout: '2026-11-07\tbbb2222\tNew work\n2026-11-01\taaa1111\tOld\n', stderr: '' } }
    }
    if (a.startsWith('merge-base')) {
      return { value: { exitCode: o.ancestor === false ? 1 : 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('http.fetch', (_, e) => {
    const path = decodeURIComponent(e.url.slice(`${BASE}/.fs/`.length))
    const method = e.init?.method ?? 'GET'
    const page = o.store.get(path)
    if (method === 'GET') {
      if (o.loginPage) {
        return { value: { status: 200, ok: true, headers: { 'content-type': 'text/html' }, text: '<html>login</html>' } }
      }
      if (o.getStatus) {
        return { value: { status: o.getStatus, ok: false, headers: {}, text: '' } }
      }
      if (!page) {
        return { value: { status: 404, ok: false, headers: {}, text: 'Not found' } }
      }
      return {
        value: {
          status: 200,
          ok: true,
          headers: { 'x-silverbullet-revision': `"r${page.rev}"`, 'x-permission': 'rw' },
          text: page.text,
        },
      }
    }
    if (method === 'PUT') {
      o.beforePut?.(path, o.store)
      const cur = o.store.get(path)
      const ifMatch = e.init?.headers?.['If-Match']
      if (ifMatch !== undefined && (!cur || ifMatch !== `"r${cur.rev}"`)) {
        return { value: { status: 412, ok: false, headers: {}, text: 'Precondition Failed' } }
      }
      puts.push(path)
      o.store.set(path, { text: e.init?.body ?? '', rev: (cur?.rev ?? 0) + 1 })
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    }
    return { value: { status: 405, ok: false, headers: {}, text: '' } }
  })

  return puts
}

test('a sync updates the date, the commits block and the index row', async ($, on) => {
  const store = seed()
  const puts = engine(on, { store })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'sb-sync' })

  expect(r.text).toContain('updated note + index')
  expect(puts).toEqual([NOTE, INDEX_PATH])
  const text = store.get(NOTE)?.text ?? ''
  expect(text).toContain('`bbb2222`')
  expect(text).toContain('## Résumé\nUn synthé de basse.')
  expect(text).toContain('[[Projects/HISE Fork/HISE Fork|HISE Fork]]')
  expect(text).not.toContain('last-activity: 2026-11-01')
  const idx = store.get(INDEX_PATH)?.text ?? ''
  expect(idx.split('\n').filter(l => l.includes('BassTone X')).length).toBe(1)
})

test('an edit made in SilverBullet meanwhile is never overwritten', async ($, on) => {
  const store = seed()
  const puts = engine(on, {
    store,
    beforePut: (path, s) => {
      if (path === NOTE && !(s.get(NOTE)?.text ?? '').includes('MY EDIT')) {
        const cur = s.get(NOTE)
        s.set(NOTE, { text: `${cur?.text ?? ''}\nMY EDIT\n`, rev: (cur?.rev ?? 0) + 1 })
      }
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'sb-sync' })

  expect(r.text).toContain('changed in SilverBullet')
  expect(puts).toEqual([])
  expect(store.get(NOTE)?.text ?? '').toContain('MY EDIT')
  expect(store.get(NOTE)?.text ?? '').toContain('`aaa1111`')
})

for (const [label, o] of [
  ['a Cloudflare login page', { loginPage: true }],
  ['a server error', { getStatus: 500 }],
] as const) {
  test(`${label} is never taken for a missing page`, async ($, on) => {
    const store = seed()
    const puts = engine(on, { store, ...o })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const r = await $.command.run({ command: 'sb-sync' })

    expect(r.text).toContain('sb-sync:')
    expect(r.text).not.toContain('/sb-sync new')
    expect(puts).toEqual([])
  })
}

test('a clone that is behind keeps the commits block but still dates the page', async ($, on) => {
  const store = seed()
  store.set(NOTE, { text: note('- 2026-11-08 · Newer elsewhere (`ccc3333`)'), rev: 1 })
  engine(on, { store, ancestor: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'sb-sync' })

  expect(r.text).toContain('commits block kept')
  const text = store.get(NOTE)?.text ?? ''
  expect(text).toContain('`ccc3333`')
  expect(text).not.toContain('`bbb2222`')
  expect(text).not.toContain('last-activity: 2026-11-01')
})

test('a missing page is reported, not created', async ($, on) => {
  const store = seed()
  store.delete(NOTE)
  const puts = engine(on, { store })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'sb-sync' })

  expect(r.text).toContain('/sb-sync new')
  expect(puts).toEqual([])
})
