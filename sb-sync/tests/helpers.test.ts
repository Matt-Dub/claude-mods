import { expect, test } from 'claude-code/testing'
import {
  backgroundToast,
  blockTopHash,
  commitsBlock,
  COMMITS_END,
  COMMITS_START,
  firstSentence,
  guardWrite,
  pageFromClaudeMd,
  parseCreds,
  putBlock,
  setField,
  splitRow,
  updateIndexText,
} from '../hooks/register'

test('the SilverBullet line maps a repository to its page', async () => {
  expect(pageFromClaudeMd('# X\n\nSilverBullet: Projects/BassTone X/\n')).toBe('Projects/BassTone X/BassTone X.md')
  expect(pageFromClaudeMd('- **SilverBullet**: `Projects/Dub Station`')).toBe('Projects/Dub Station/Dub Station.md')
  expect(pageFromClaudeMd('SilverBullet: Projects/DnD Shop.md')).toBe('Projects/DnD Shop.md')
  expect(pageFromClaudeMd('SilverBullet: Brain/X/')).toBeUndefined()
  expect(pageFromClaudeMd('SilverBullet: Projects/../Brain/')).toBeUndefined()
  expect(pageFromClaudeMd('no line here')).toBeUndefined()
})

test('credentials parse like a sourced shell file', async () => {
  const kv = parseCreds('export SB_URL="https://sb.example"\nCF_ID=abc\r\n# comment\nSB_TOKEN=\'t\'\n')
  expect(kv.SB_URL).toBe('https://sb.example')
  expect(kv.CF_ID).toBe('abc')
  expect(kv.SB_TOKEN).toBe('t')
})

test('a write that empties or guts a page is refused', async () => {
  expect(guardWrite('', 'abc')).toBeDefined()
  expect(guardWrite('   \n', undefined)).toBeDefined()
  expect(guardWrite('a'.repeat(40), 'a'.repeat(100))).toBeDefined()
  expect(guardWrite('a'.repeat(60), 'a'.repeat(100))).toBeUndefined()
  expect(guardWrite('new page', undefined)).toBeUndefined()
})

test('the commits block is replaced in place and its top hash read back', async () => {
  const block = commitsBlock('2026-11-07\tabc1234\tFix x\n2026-11-06\tdef5678\tAdd y\n')
  expect(block).toBeDefined()
  const page = `---\nlast-activity: 2026-11-01\n---\n# P\n\n${COMMITS_START}\nold\n${COMMITS_END}\n\n## Liens\n- l\n`
  const next = putBlock(page, block ?? '')
  expect(next.includes('old')).toBe(false)
  expect(next.includes('## Liens\n- l')).toBe(true)
  expect(blockTopHash(next)).toBe('abc1234')
  expect(blockTopHash('# no block')).toBeUndefined()
  expect(putBlock('# P\n\n## Liens\n- l\n', block ?? '').indexOf(COMMITS_START) < '# P\n\n'.length + 1).toBe(true)
})

test('frontmatter fields are set without touching the body', async () => {
  const t = setField('---\ntype: Project\nlast-activity: 2026-11-01\n---\n# P\n', 'last-activity', '2026-11-07')
  expect(t).toBe('---\ntype: Project\nlast-activity: 2026-11-07\n---\n# P\n')
})

const INDEX = `---
type: Index
updated: 2026-11-04
---
# Projets récents

| Projet | Statut | Résumé | Dernière activité |
|---|---|---|---|
| [[Projects/Email Responder/Email Responder]] | en cours | File | 2026-11-04 |
| [[Projects/BassTone X/BassTone X|BassTone]] | en cours | Synthé | 2026-11-01 |

## Par famille
- x
`

test('the index row is found by its full-path link, dated and sorted, never duplicated', async () => {
  const r = updateIndexText(INDEX, 'Projects/BassTone X/BassTone X.md', '2026-11-07')
  expect(r.found).toBe(true)
  const rows = r.text.split('\n').filter(l => l.startsWith('| [['))
  expect(rows.length).toBe(2)
  expect(rows[0]).toBe('| [[Projects/BassTone X/BassTone X|BassTone]] | en cours | Synthé | 2026-11-07 |')
  expect(r.text.includes('updated: 2026-11-07')).toBe(true)
  expect(r.text.includes('## Par famille\n- x')).toBe(true)
  // Once more on the same day: nothing changes.
  expect(updateIndexText(r.text, 'Projects/BassTone X/BassTone X.md', '2026-11-07').text).toBe(r.text)
})

test('the index date never goes backwards and an unknown project adds no row', async () => {
  expect(updateIndexText(INDEX, 'Projects/Email Responder/Email Responder.md', '2026-11-01').text).toBe(INDEX)
  const r = updateIndexText(INDEX, 'Projects/New/New.md', '2026-11-07')
  expect(r.found).toBe(false)
  expect(r.text).toBe(INDEX)
  const added = updateIndexText(INDEX, 'Projects/New/New.md', '2026-11-07', 'Un nouveau')
  expect(added.text.includes('| [[Projects/New/New]] | en cours | Un nouveau | 2026-11-07 |')).toBe(true)
})

test('table cells split around wiki-link aliases', async () => {
  expect(splitRow('| [[a|b]] | c |')).toEqual(['', ' [[a|b]] ', ' c ', ''])
})

test('a background note toasts once, a change every time', async () => {
  const seen = new Set<string>()
  const r = { page: 'Projects/P/P.md', changed: [] as string[], notes: ['no row for it in index'] }
  expect(backgroundToast(r, seen)).toBe('Projects/P/P.md: no row for it in index')
  expect(backgroundToast(r, seen)).toBeUndefined()
  expect(backgroundToast({ ...r, changed: ['note'] }, seen)).toBe('Projects/P/P.md: updated note')
})

test('the summary skips headings', async () => {
  expect(firstSentence('## Résumé\n\n## État actuel\n- x')).toBeUndefined()
  expect(firstSentence('## Résumé\nUn plugin.\n\n## État actuel')).toBe('Un plugin.')
})
