import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isOn = atom({ plugin: 'prompt-rewrite', key: 'isOn' } as const, false)

const MODEL = 'sonnet'
const MIN_CHARS = 12

const SYSTEM = `You rewrite a user's prompt to an AI coding assistant (Claude Code) so the assistant understands it better.

Rules:
- Keep the user's language (French stays French, English stays English).
- Keep the exact intent, scope and every concrete detail: file names, paths, code, commands, errors, numbers, names. Never invent requirements, files or facts.
- Fix spelling and grammar, remove ambiguity, put the goal first, then context, then constraints or expected result.
- Use short structure (a goal line, then bullets) only when the prompt holds several parts; a simple request stays one or two sentences.
- Do not answer the prompt, do not add commentary, do not ask questions.
- If the prompt is already clear, return it with only minimal fixes.

Output only the rewritten prompt, nothing else.`

async function rewrite($: EngineInterface, text: string): Promise<string | undefined> {
  const r = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: `<prompt>\n${text}\n</prompt>`,
    maxTokens: 2048,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!r.isAnswered) {
    return undefined
  }
  const out = r.text.trim().replace(/^<prompt>\s*|\s*<\/prompt>$/g, '')

  return out.length > 0 ? out : undefined
}

function originalNote(text: string): string {
  return `The prompt-rewrite mod rewrote the user's prompt for clarity. Their original wording, which wins on any doubt:\n<original_prompt>\n${text}\n</original_prompt>`
}

const SEND = 'Envoyer la réécriture'
const ORIGINAL = "Envoyer l'original"
const EDIT = 'Modifier'

type Choice =
  | { kind: 'send'; text: string }
  | { kind: 'original' }
  | { kind: 'edit' }
  | { kind: 'cancel' }

// Shows the rewrite and lets the user send it, keep the original, edit it in
// the prompt box, or type a replacement under "Other". Dismissing cancels.
async function confirm($: EngineInterface, better: string): Promise<Choice> {
  let answer: string
  try {
    answer = await $.ui.ask(`Prompt réécrit :\n\n${better}\n\nL'envoyer ?`, {
      header: 'Rewrite',
      options: [SEND, ORIGINAL, EDIT],
    })
  } catch {
    return { kind: 'cancel' }
  }
  if (answer === SEND) {
    return { kind: 'send', text: better }
  }
  if (answer === ORIGINAL) {
    return { kind: 'original' }
  }
  if (answer === EDIT) {
    return { kind: 'edit' }
  }
  const typed = answer.trim()

  return typed.length > 0 ? { kind: 'send', text: typed } : { kind: 'cancel' }
}

// Original text of a rewrite the user chose to edit: their next typed prompt
// is that edit, sent without a second rewrite.
let editing: string | undefined

function fillLater($: EngineInterface, text: string) {
  $.clock.after(300, () => {
    void $.prompt.fill({ text })
  })
}

// A prompt submitted while the command is still running can be dropped, so
// submit once the command has returned, and say so if it does not enter.
function submitLater($: EngineInterface, text: string) {
  $.clock.after(300, () => {
    $.prompt.submit({ text, asUser: true }).then(
      r => {
        if (r.drop !== undefined) {
          $.ui.toast(`Rewrite not sent: ${r.drop}`)
          void $.prompt.fill({ text })
        }
      },
      (err: unknown) => {
        $.ui.toast(`Rewrite not sent: ${err instanceof Error ? err.message : String(err)}`)
        void $.prompt.fill({ text })
      },
    )
  })
}

function showStatus($: EngineInterface, on: boolean) {
  $.ui.status(on ? 'rewrite on' : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rewrite',
      description: 'Toggle prompt rewriting, or rewrite and send one prompt',
      argumentHint: '[on|off|<prompt>]',
    })
    showStatus($, await read($, isOn))

    return next(e)
  })

  on('command.run', { command: 'rewrite' }, async ($, e) => {
    const arg = e.args.trim()
    const lower = arg.toLowerCase()

    if (arg === '' || lower === 'on' || lower === 'off') {
      const now = await update($, isOn, was => (arg === '' ? !was : lower === 'on'))
      showStatus($, now)

      return {
        text: now
          ? 'Prompt rewriting on: each prompt is rewritten before Claude reads it. /rewrite again turns it off.'
          : 'Prompt rewriting off.',
      }
    }

    const better = await rewrite($, arg)
    if (better === undefined) {
      return { text: 'Rewrite failed; prompt not sent. Try again or send it as is.' }
    }
    const choice = await confirm($, better)
    if (choice.kind === 'cancel') {
      return { text: 'Rewrite cancelled; nothing sent.' }
    }
    if (choice.kind === 'edit') {
      editing = arg
      fillLater($, better)

      return { text: 'Rewritten prompt put in the prompt box: edit it, then send.' }
    }
    const text = choice.kind === 'original' ? arg : choice.text
    submitLater($, text)

    return { text: `Sending:\n\n${text}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isTyped || e.command || e.isMeta) {
      return next(e)
    }
    if (editing !== undefined) {
      const original = editing
      editing = undefined

      return next({ ...e, context: [...(e.context ?? []), originalNote(original)] })
    }
    if (e.text.trim().length < MIN_CHARS || !(await read($, isOn))) {
      return next(e)
    }

    const better = await rewrite($, e.text)
    if (better === undefined) {
      $.ui.toast('Rewrite failed; original prompt sent')

      return next(e)
    }
    if (better === e.text.trim()) {
      return next(e)
    }

    const choice = await confirm($, better)
    switch (choice.kind) {
      case 'send':
        return next({ ...e, text: choice.text, context: [...(e.context ?? []), originalNote(e.text)] })
      case 'original':
        return next(e)
      case 'edit':
        editing = e.text
        fillLater($, better)

        return { drop: 'Rewrite put in the prompt box: edit it, then send.' }
      case 'cancel':
        fillLater($, e.text)

        return { drop: 'Rewrite cancelled; your prompt is back in the box.' }
    }
  })
}
