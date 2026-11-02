import type { Register } from 'claude-code'

const FILE = 'relay.md'

function ask(focus: string): string {
  return `Stop the current work. Write a handoff document so a brand-new Claude Code session, with none of this conversation, can pick up exactly where we are.

Write it in the language the user writes in. Be concise but complete: every fact the next session needs, nothing it does not. Concrete over vague: name files with full paths, commands, errors, values. Some paths only live as long as this session (scratchpad and temp directories, bundled-skill caches under /tmp or /private/tmp, session ids): leave them out, or mark them as tied to this session and say how the next session gets the equivalent. No tools: answer with the document only, as Markdown, no preamble and no code fence around it.

Use these sections, in this order:

# Relay: <short title of the work>

## Objectif
What we are trying to achieve, and what "done" looks like.

## Déjà fait
What is finished and verified, and where it lives. Say what was not verified.

## Reste à faire
Start with one line "Prochaine action :" naming the very next concrete step (what to do, on which file or command). Then the remaining steps, in order, each actionable.

## Décisions
What was decided and why, including approaches rejected, so the next session does not reopen them. Include the user's stated preferences and constraints.

## Fichiers clés
The files touched or to read first, each with its full path and one line on its role.

## Pièges
Errors met, dead ends and what did not work, with why, so the next session does not repeat them. Write "Aucun." if there were none.

## Commandes utiles
How to run, test or build what we work on, as exact commands. Leave this section out entirely if no command matters.

## Questions ouvertes
What still waits on the user's answer or choice. Leave this section out entirely if nothing does.
${focus ? `\nThe user adds this for the handoff: ${focus}\n` : ''}
(Translate the section headings if the user does not write in French.)`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'relay',
      description: 'Write relay.md to hand the work off to a fresh session',
      argumentHint: '[note for the handoff]',
    })

    return next(e)
  })

  on('command.run', { command: 'relay' }, async ($, e) => {
    $.ui.status('relay: writing relay.md…')
    try {
      const r = await $.model.fork({ prompt: ask(e.args.trim()) })
      if (!r.isAnswered) {
        const why = r.reason === 'nothing-to-fork' ? 'no finished turn to hand off yet' : r.reason
        return { text: `relay.md not written: ${why}.` }
      }

      const doc = r.text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')
      await $.fs.write(FILE, `${doc}\n`)
      const where = `${await $.session.cwd()}/${FILE}`

      return {
        text: `Handoff written to ${where}.\n\nIn a new session (/clear, or a new \`claude\`), send:\n  Lis ${FILE} et reprends le travail.`,
      }
    } finally {
      $.ui.status(undefined)
    }
  })
}
