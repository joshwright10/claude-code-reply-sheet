import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import { compactReply, fieldRows, missingLines, missingWarning, parseDraft, RULES, serializeDraft } from './draft'

const isDrafting = atom({ plugin: 'reply-sheet', key: 'isDrafting' } as const, false)
// Change the shape tag when Form changes: it drops what an older version stored.
const form = atom({ plugin: 'reply-sheet', key: 'form' } as const, null, { shape: 'form-2' })
const warning = atom({ plugin: 'reply-sheet', key: 'warning' } as const, null)
const PANE = 'reply-sheet'

const DRAFT = 'response.md'
const MODEL = 'haiku'
// Nerd Font glyphs: md-microsoft_visual_studio_code, md-send. Only terminals that bundle them get icons.
const NERD_TERMINALS = ['ghostty', 'wezterm']
const VSCODE_GLYPH = '\u{F0A1E}'
const SEND_GLYPH = '\u{F048A}'
const EDIT_GLYPH = '\u{F03EB}' // md-pencil

type Api = EngineInterface

const isBuilding = atom({ plugin: 'reply-sheet', key: 'isBuilding' } as const, false)
let cachedDir: { id: string; dir: string } | undefined

const isWindows = async ($: Api) => (await $.env.get('OS')) === 'Windows_NT'

async function tryRun($: Api, argv: string[]): Promise<boolean> {
  try {
    return (await $.process.run(argv, { timeoutMs: 15000 })).exitCode === 0
  } catch {
    return false
  }
}

// The mod API does not expose the scratchpad, and Claude Code's layout differs by OS (and hashes long
// project names), so find "<temp root>/claude*/<project>/<session id>/scratchpad" instead of rebuilding it.
async function findScratchpad($: Api, id: string): Promise<string | undefined> {
  const roots = new Set<string>()
  const vars = [
    await $.env.get('CLAUDE_CODE_TMPDIR'),
    await $.env.get('TMPDIR'),
    await $.env.get('TEMP'),
    await $.env.get('TMP'),
  ]
  for (const v of vars) if (v) roots.add(v.replace(/[\\/]+$/, ''))
  if (!(await isWindows($))) ['/tmp', '/private/tmp'].forEach(r => roots.add(r))
  for (const root of roots) {
    const tops = await $.fs.list(root).catch(() => [])
    const bases = [root, ...tops.filter(t => t.kind === 'dir' && t.name.startsWith('claude')).map(t => `${root}/${t.name}`)]
    for (const base of bases) {
      const projects = await $.fs.list(base).catch(() => [])
      for (const p of projects) {
        if (p.kind !== 'dir') continue
        const dir = `${base}/${p.name}/${id}/scratchpad`
        if (await $.fs.exists(dir)) return dir
      }
    }
  }
  return undefined
}

async function scratchpad($: Api): Promise<string> {
  const id = await $.session.id()
  if (cachedDir?.id === id) return cachedDir.dir
  let dir = await findScratchpad($, id)
  if (!dir) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
    dir = `${home}/.claude/reply-sheet/${id}`
    $.ui.toast(`Scratchpad not found, using ${dir}`)
  }
  cachedDir = { id, dir }
  return dir
}

// Opens in VS Code if installed (macOS, Windows, Linux), else in the OS default app. Returns what opened it.
async function openPaths($: Api, paths: string[]): Promise<string> {
  const target = paths[paths.length - 1] ?? '.'
  if (await isWindows($)) {
    const win = paths.map(p => p.replace(/\//g, '\\'))
    const local = await $.env.get('LOCALAPPDATA')
    const programs = await $.env.get('ProgramFiles')
    const exes = [local && `${local}\\Programs\\Microsoft VS Code\\Code.exe`, programs && `${programs}\\Microsoft VS Code\\Code.exe`]
    if (await tryRun($, ['cmd', '/c', 'code', '-r', ...win])) return 'VS Code'
    for (const exe of exes) if (exe && (await $.fs.exists(exe)) && (await tryRun($, [exe, '-r', ...win]))) return 'VS Code'
    await tryRun($, ['explorer', win[win.length - 1] ?? '.'])
    return 'the default app'
  }
  const macCli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
  if ((await $.fs.exists(macCli)) && (await tryRun($, [macCli, '-r', ...paths]))) return 'VS Code'
  if (await tryRun($, ['code', '-r', ...paths])) return 'VS Code'
  if (await tryRun($, ['open', '-a', 'Visual Studio Code', ...paths])) return 'VS Code'
  if (await tryRun($, ['open', target])) return 'the default app'
  await tryRun($, ['xdg-open', target])
  return 'the default app'
}

async function openScratchpad($: Api): Promise<string> {
  const dir = await scratchpad($)
  if (!(await $.fs.exists(dir))) await $.fs.write(`${dir}/.keep`, '')
  return `Opened ${dir} in ${await openPaths($, [dir])}.`
}

// The "icons" setting from /config (plugin.json userConfig); a change there reloads the module.
let iconMode = 'on'

// on: any terminal with a Nerd Font; off: never; auto: only terminals that ship the icons.
async function nerdIcons($: Api): Promise<boolean> {
  if (iconMode === 'on') return true
  if (iconMode === 'off') return false
  const term = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  return NERD_TERMINALS.includes(term)
}

async function hasDraft($: Api, file: string): Promise<boolean> {
  if (!(await $.fs.exists(file))) return false
  return (await $.fs.read(file)).trim() !== ''
}

// The assistant messages since the last real prompt (a user message with text, not tool results).
function latestTurn(messages: readonly SessionMessage[]): SessionMessage[] {
  const turn: SessionMessage[] = []
  for (const m of [...messages].reverse()) {
    if (m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length) break
    if (m.role === 'assistant') turn.unshift(m)
  }
  return turn
}

async function sourceText($: Api): Promise<string> {
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return ''
  const turn = latestTurn(messages)
  const parts: string[] = []
  const files = new Set<string>()
  for (const m of turn) {
    for (const u of m.toolUses) {
      const path = u.input.file_path
      if ((u.tool === 'Write' || u.tool === 'Edit') && typeof path === 'string' && path.endsWith('.md') && !/\/response[^/]*\.md$/.test(path)) {
        files.add(path)
      }
    }
  }
  for (const path of files) {
    if (await $.fs.exists(path)) parts.push(`--- File the assistant wrote: ${path} ---\n${await $.fs.read(path)}`)
  }
  const text = turn.map(m => m.text).filter(t => t.trim() !== '').join('\n\n')
  if (text) parts.push(`--- Assistant's reply ---\n${text}`)
  return parts.join('\n\n')
}

async function buildDraft($: Api, file: string): Promise<string> {
  const source = await sourceText($)
  if (source === '') return 'Nothing to respond to yet: no assistant reply found.'
  const r = await $.model.complete({ model: MODEL, system: RULES, prompt: source, maxTokens: 32000, effort: 'low' })
  if (!r.isAnswered) return `Haiku could not build the file (${r.reason}).`
  const md = r.text.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, '$1').trim()
  await $.fs.write(file, `${md}\n`)
  await update($, warning, () => missingWarning(missingLines(source, md)))
  return ''
}

// Builds response.md with Haiku when there is no draft. Returns an error message, or the paths.
async function ensureDraft($: Api): Promise<{ error: string } | { dir: string; file: string; built: boolean }> {
  const dir = await scratchpad($)
  const file = `${dir}/${DRAFT}`
  if (await hasDraft($, file)) return { dir, file, built: false }
  if (await read($, isBuilding)) return { error: 'Already building response.md.' }
  await update($, isBuilding, () => true)
  $.ui.toast(`Building ${DRAFT} with Haiku...`)
  try {
    const error = await buildDraft($, file)
    if (error) return { error }
  } finally {
    await update($, isBuilding, () => false)
  }
  const warn = await read($, warning)
  if (warn) $.ui.toast(warn)
  await update($, isDrafting, () => true)
  return { dir, file, built: true }
}

async function startResponse($: Api): Promise<string> {
  const draft = await ensureDraft($)
  if ('error' in draft) return draft.error
  const app = await openPaths($, [draft.dir, draft.file])
  await update($, isDrafting, () => true)
  const ready = draft.built ? 'Ready. ' : ''
  return `${ready}Opened ${draft.file} in ${app}. Save it, then click "Submit response" or run /reply submit.`
}

// --- In-terminal reply pane ---

async function saveForm($: Api): Promise<void> {
  const f = await read($, form)
  if (f) await $.fs.write(f.file, serializeDraft(f))
}

async function openPane($: Api): Promise<string> {
  const draft = await ensureDraft($)
  if ('error' in draft) return draft.error
  const md = await $.fs.read(draft.file)
  await update($, form, () => parseDraft(draft.file, md))
  await update($, isDrafting, () => true)
  const opened = await $.ui.open({ id: PANE, title: 'Respond', focus: true })
  return opened.isPlaced ? '' : `Pane not shown (${opened.reason}). Widen the terminal or use the VS Code button.`
}

// Saves the pane's answers, closes it, and drops the form so no stale copy overwrites later file edits.
async function closePane($: Api): Promise<void> {
  if (!(await read($, form))) return
  await saveForm($)
  await $.ui.close({ id: PANE })
  await update($, form, () => null)
}

async function submitResponse($: Api): Promise<string> {
  await closePane($)
  const dir = await scratchpad($)
  const file = `${dir}/${DRAFT}`
  if (!(await hasDraft($, file))) {
    await update($, isDrafting, () => false)
    return `No draft at ${file}. Run /reply first.`
  }
  const md = (await $.fs.read(file)).replace(/<!--[\s\S]*?-->/g, '')
  const body = compactReply(parseDraft(file, md))
  if (body === '') return 'Nothing to submit: no item has a response yet.'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archived = `${dir}/response-${stamp}.md`
  // Copy then blank the draft: no file delete/rename in $.fs, and mv is not on Windows.
  await $.fs.write(archived, await $.fs.read(file))
  await $.fs.write(file, '')
  await update($, isDrafting, () => false)
  await update($, warning, () => null)
  void $.prompt.submit({
    text: `My responses to your last answer, by item heading (full file with the item text: ${archived}):\n\n${body}`,
  })
  return `Submitted. Archived to ${archived}.`
}

export const register: Register = (on, options) => {
  iconMode = typeof options.icons === 'string' ? options.icons : 'on'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reply',
      description: 'Reply in a Markdown file in VS Code. "/reply submit" sends it.',
    })
    await $.command.register({
      name: 'scratchpad',
      description: 'Open the session scratchpad folder in VS Code',
    })
    const dir = await scratchpad($)
    const drafting = await hasDraft($, `${dir}/${DRAFT}`)
    await update($, isDrafting, () => drafting)
    // A reload mid-build would leave this stuck on.
    await update($, isBuilding, () => false)
    return next(e)
  })

  on('command.run', { command: 'reply' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'submit') return { text: await submitResponse($) }
    return { text: await startResponse($) }
  })

  on('command.run', { command: 'scratchpad' }, async $ => ({ text: await openScratchpad($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is shared by all plugins: keep what the others drew.
    const theirs = await next(e)
    if (e.props.hasSurvey) return theirs
    const drafting = await read($, isDrafting)
    const building = await read($, isBuilding)
    const paneOpen = (await read($, form)) !== null
    const nerd = await nerdIcons($)
    const VSCODE = nerd ? `${VSCODE_GLYPH} ` : ''
    const SEND = nerd ? `${SEND_GLYPH} ` : ''
    const EDIT = nerd ? `${EDIT_GLYPH} ` : ''
    const { Box, Button, Text } = $.ui.resolve(e)
    const row = (
      <Box flexDirection="row">
        <Text color="cyan" bold>
          Reply sheet -&gt;{' '}
        </Text>
        <Button
          key="here"
          label={`${EDIT}${building ? 'Building response...' : 'Respond here'}`}
          onPress={() => openPane($).then(t => t && $.ui.toast(t))}
        />
        <Button
          key="respond"
          label={`${VSCODE}${drafting ? 'Open response' : 'Respond in Markdown'}`}
          onPress={() => startResponse($).then(t => $.ui.toast(t))}
        />
        {drafting && (
          <Button key="submit" onPress={() => submitResponse($).then(t => $.ui.toast(t))}>
            <Text color="green">{`${SEND}Submit response`}</Text>
          </Button>
        )}
        {paneOpen && (
          <Button key="band-save" onPress={() => saveForm($).then(() => $.ui.toast('Saved.'))}>
            <Text color="cyan">Save</Text>
          </Button>
        )}
        {paneOpen && (
          <Button key="band-close" onPress={() => closePane($)}>
            <Text color="red">Close pane</Text>
          </Button>
        )}
        <Button
          key="scratchpad"
          label={`${VSCODE}Open scratchpad`}
          onPress={() => openScratchpad($).then(t => $.ui.toast(t))}
        />
      </Box>
    )
    return theirs ? (
      <Box flexDirection="column">
        {row}
        {theirs}
      </Box>
    ) : (
      row
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Input, Markdown } = $.ui.resolve(e)
    const f = await read($, form)
    if (!f) return <Text dimColor>No draft loaded. Click "Respond here" again.</Text>
    const setItem = (i: number, value: string, bump = 0) =>
      update($, form, cur =>
        cur ? { ...cur, items: cur.items.map((it, j) => (j === i ? { ...it, response: value, rev: it.rev + bump } : it)) } : cur,
      )
    const setGeneral = (value: string, bump = 0) =>
      update($, form, cur => (cur ? { ...cur, general: value, generalRev: cur.generalRev + bump } : cur))
    const save = () => saveForm($).then(() => $.ui.toast('Saved.'))
    const cols = e.viewport?.columns ?? 80
    // Drawn at the top and the bottom of the pane; keys must differ per copy.
    const controls = (at: string) => (
      <Box key={`controls-${at}`} flexDirection="row" marginTop={at === 'bottom' ? 1 : 0}>
        <Button key={`submit-${at}`} onPress={() => submitResponse($).then(t => $.ui.toast(t))}>
          <Text color="green">Submit</Text>
        </Button>
        <Button key={`save-${at}`} onPress={save}>
          <Text color="cyan">Save</Text>
        </Button>
        <Button key={`vscode-${at}`} label="Open in VS Code" onPress={() => closePane($).then(() => startResponse($)).then(t => $.ui.toast(t))} />
        <Button key={`close-${at}`} onPress={() => closePane($)}>
          <Text color="red">Close</Text>
        </Button>
      </Box>
    )
    const warn = await read($, warning)
    return (
      <Box flexDirection="column">
        {controls('top')}
        {warn && <Text color="yellow">{warn}</Text>}
        <Text dimColor>Type under each item. Enter saves; add a new line the same way as in the prompt box. Submit sends only the items you answered.</Text>
        {f.items.map((it, i) => (
          <Box key={`item-${i}`} flexDirection="column" marginTop={1}>
            <Markdown text={it.body} />
            <Input
              key={`r-${i}-${it.rev}`}
              label="Response: "
              rows={fieldRows(it.response, cols)}
              value={it.response}
              submitLabel="save"
              onInput={v => void setItem(i, v)}
              onSubmit={v => void setItem(i, v, 1).then(save)}
            />
          </Box>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Other comments</Text>
          <Input
            key={`general-${f.generalRev}`}
            rows={fieldRows(f.general, cols)}
            value={f.general}
            submitLabel="save"
            onInput={v => void setGeneral(v)}
            onSubmit={v => void setGeneral(v, 1).then(save)}
          />
        </Box>
        {controls('bottom')}
      </Box>
    )
  })
}
