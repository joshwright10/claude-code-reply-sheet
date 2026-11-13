// Pure response-file logic: Haiku's rules, parsing, writing back, the compact reply and the coverage check.
import type { Form, FormItem } from '../types'

export const PREAMBLE = 'Add your replies under each Response: line.'

export const RULES = `You turn an AI assistant's output into a Markdown file the user fills in to reply.
- First line: "${PREAMBLE}"
- An item is one section of the original: a heading or bold title line together with ALL the bullets, paragraphs, tables and code under it, up to the next section. A finding, a question, or a standalone paragraph with no title is also one item.
- Start each item with one "## " heading: the section's own title (without ** marks), or a short title you write (max 8 words) if it has none. Then copy the item's full original text below the heading, unchanged, except drop the title line itself when it became the heading (do not repeat it). Never turn a bullet or a sentence into a heading, and never split one section into several items.
- Exception, tables: never copy a Markdown table. Each table row becomes its own item: a "## " heading of the row number (if any) and a short title from the row, then one "- Column: value" bullet per column, every column kept. Any text around the table (an intro line) goes with the first row's item. Do not give the table's own title an item of its own.
- Exception, numbered or bulleted lists of questions: each question becomes its own item whose heading is "Q" + its number + ". " + the full question, unchanged (e.g. "## Q3. Is #77 safe to merge before #514 lands?"). Put nothing between that heading and its "Response:" line; do not repeat the question.
- Never drop a section, note, checklist or instruction, even one that looks like a side note; every one becomes an item. Only a one-line greeting or sign-off may be left out. Do not summarise. Keep other lists, code and links as they are. Nothing may sit between a "Response:" line and the next "## " heading.
- Example. Original:
  **2. Shortcut for Submit**
  - Press Esc, then s.
  - /reply submit also works.
  Becomes:
  ## 2. Shortcut for Submit

  - Press Esc, then s.
  - /reply submit also works.

  Response:

- Under each item put an empty line, then a line with exactly "Response:" (plain text, not bold), then an empty line.
- End the file with "## Other comments" followed by an empty line.
- Output only the Markdown file content, no code fences, no commentary.`

const OTHER = /^## (Other comments|General response)[ \t]*$/im // "General response" is the older name

// Each item is the text above a "Response:" line; its response runs to the next heading.
export function parseDraft(file: string, md: string): Form {
  const gen = md.search(OTHER)
  const main = gen >= 0 ? md.slice(0, gen) : md
  const general = gen >= 0 ? md.slice(gen).replace(/^## (Other comments|General response)[ \t]*\n?/i, '').trim() : ''
  const items: FormItem[] = []
  let body: string[] = []
  let resp: string[] | null = null
  const push = () => {
    if (resp === null && body.join('').trim() === '') return
    items.push({ body: body.join('\n').trim(), response: (resp ?? []).join('\n').trim(), rev: 0 })
    body = []
    resp = null
  }
  let inCode = false
  for (const line of main.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode
    const m = inCode ? null : /^\**Response:\**\s?(.*)$/.exec(line)
    if (m) {
      if (resp !== null) push()
      resp = [m[1] ?? '']
    } else if (resp !== null && !inCode && line.startsWith('#')) {
      push()
      body.push(line)
    } else if (resp !== null) {
      resp.push(line)
    } else {
      body.push(line)
    }
  }
  push()
  // A heading-only item (a table's title) gets no box: fold it into the next item as context.
  const merged: FormItem[] = []
  let carry = ''
  for (const it of items) {
    const lines = it.body.split('\n')
    // A question is its heading alone ("## Q3. ...?"), so it keeps its box.
    const isQuestion = lines.some(l => /^#+\s*Q\d+\./.test(l) || (l.startsWith('#') && l.trim().endsWith('?')))
    const titleOnly =
      !isQuestion && it.response === '' && lines.every(l => l.trim() === '' || l.startsWith('#') || l.startsWith(PREAMBLE))
    if (titleOnly && it !== items[items.length - 1]) {
      carry = `${carry}${it.body}\n\n`
      continue
    }
    merged.push(carry ? { ...it, body: `${carry}${it.body}` } : it)
    carry = ''
  }
  return { file, items: merged, general, generalRev: 0 }
}

export function serializeDraft(form: Form): string {
  const items = form.items.map(i => `${i.body}\n\nResponse: ${i.response}`.trimEnd())
  return `${items.join('\n\n')}\n\n## Other comments\n\n${form.general}\n`
}

// The item's own heading (the last one: a folded-in table title sits above it), else its first real line.
export function itemLabel(body: string): string {
  const lines = body.split('\n')
  const first =
    [...lines].reverse().find(l => l.startsWith('#')) ?? lines.find(l => l.trim() !== '' && !l.startsWith(PREAMBLE)) ?? ''
  const text = first.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

// What Claude gets on submit: only answered items, each as its heading plus the answer, since
// Claude already has the item text in context. The full file stays on disk.
export function compactReply(f: Form): string {
  const parts = f.items.filter(i => i.response.trim() !== '').map(i => `## ${itemLabel(i.body)}\n${i.response.trim()}`)
  if (f.general.trim() !== '') parts.push(`## Other comments\n${f.general.trim()}`)
  return parts.join('\n\n')
}

// Rows for a field so all its text shows: wrapped lines plus one spare, at least 3.
export function fieldRows(text: string, columns: number): number {
  const width = Math.max(20, columns - 14)
  const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / width)), 0)
  return Math.min(60, Math.max(3, lines + 1))
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\s*[-*]\s/gm, ' ')
    .replace(/[*`_#>|:]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')

// Source lines Haiku left out of the file. Prose lines must keep half their 3-word runs; table rows
// (reshaped into bullets) must keep every cell. Headings and bold-only titles are skipped: Haiku
// reshapes them on purpose, and the lines under them are still checked.
export function missingLines(source: string, md: string): string[] {
  const out = ` ${norm(md)} `
  const missing: string[] = []
  for (const raw of source.split('\n')) {
    const t = raw.trim()
    if (!t || /^--- .* ---$/.test(t) || /^\|[\s|:-]+\|$/.test(t) || t.startsWith('#') || /^\*\*[^*]+\*\*:?$/.test(t)) continue
    if (t.startsWith('|')) {
      const cells = t.replace(/^\||\|$/g, '').split('|').map(norm)
      if (cells.some(c => c.length >= 3 && !out.includes(c))) missing.push(t)
      continue
    }
    const w = norm(t).split(' ')
    if (w.length < 3) {
      if (!out.includes(norm(t))) missing.push(t)
      continue
    }
    const runs = w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(' '))
    if (runs.filter(r => out.includes(r)).length / runs.length < 0.5) missing.push(t)
  }
  return missing
}

export function missingWarning(missing: string[]): string | null {
  if (missing.length === 0) return null
  const first = missing[0] ?? ''
  const sample = first.length > 80 ? `${first.slice(0, 77)}...` : first
  const more = missing.length > 1 ? ` and ${missing.length - 1} more line(s)` : ''
  return `Haiku left out "${sample}"${more}. Check Claude's answer in the chat for anything to reply to.`
}
