import { expect, test } from 'claude-code/testing'

import { compactReply, fieldRows, itemLabel, missingLines, missingWarning, parseDraft, serializeDraft } from '../hooks/draft'
import { costDraft, costSource, sectionsDraft, sectionsSource } from './fixtures'

const labels = (md: string) => parseDraft('f.md', md).items.map(i => itemLabel(i.body))

test('table rows and questions each get their own item', () => {
  expect(labels(costDraft)).toEqual([
    'rg-monitoring-dev, Storage',
    'rg-sql-prod, Azure SQL',
    'rg-aks-test, AKS',
    'rg-search-demo, AI Search',
    'Q1. Should I open a ticket for the `rg-sql-prod` index job schedule?',
    'Q2. Can the `rg-search-demo` replicas go back to 1?',
    'Q3. Do you want this report weekly in the team channel?',
  ])
  expect(parseDraft('f.md', costDraft).general).toBe('That looks great! Is this Plugin now ready for general use?')
})

test('a heading with nothing under it folds into the next item, a question does not', () => {
  const md = `## Audit results

## 1. prodarchive01

- Issue: Soft delete off

Response: yes

## Q1. Ship it?

Response:

## Other comments
`
  const f = parseDraft('f.md', md)
  expect(f.items.map(i => itemLabel(i.body))).toEqual(['1. prodarchive01', 'Q1. Ship it?'])
  expect(f.items[0]?.body).toContain('## Audit results')
  expect(f.items[0]?.response).toBe('yes')
})

test('the instruction line is never used as a label', () => {
  const md = `Add your replies under each Response: line.

Some intro with no heading.

Response: ok
`
  expect(labels(md)).toEqual(['Some intro with no heading.'])
})

test('"Response:" inside a code block does not split an item', () => {
  const md = '## Example\n\n```\nResponse: not a field\n```\n\nResponse: real answer\n\n## Other comments\n'
  const f = parseDraft('f.md', md)
  expect(f.items.length).toBe(1)
  expect(f.items[0]?.response).toBe('real answer')
  expect(f.items[0]?.body).toContain('Response: not a field')
})

test('multi-line answers survive, and the older "General response" name is read', () => {
  const md = '## One\n\nText.\n\nResponse: line 1\nline 2\n\n## General response\n\nbye\n'
  const f = parseDraft('f.md', md)
  expect(f.items[0]?.response).toBe('line 1\nline 2')
  expect(f.general).toBe('bye')
})

test('writing a parsed file back and reading it again keeps every item and answer', () => {
  for (const md of [costDraft, sectionsDraft]) {
    const first = parseDraft('f.md', md)
    const again = parseDraft('f.md', serializeDraft(first))
    expect(again.items.map(i => [itemLabel(i.body), i.response])).toEqual(first.items.map(i => [itemLabel(i.body), i.response]))
    expect(again.general).toBe(first.general)
  }
})

test('submit sends only answered items and other comments', () => {
  expect(compactReply(parseDraft('f.md', sectionsDraft))).toBe(
    '## Other comments\nGreat, I didn\'t respond to any of the other items here, only to Other Comments. Check that came through right.',
  )
  const f = parseDraft('f.md', '## A\n\nx\n\nResponse: yes\n\n## B\n\ny\n\nResponse:\n\n## Other comments\n')
  expect(compactReply(f)).toBe('## A\nyes')
})

test('the dropped "What to check" section and sample-data note are reported', () => {
  const missing = missingLines(costSource, costDraft)
  expect(missing).toEqual([
    '- The table title has **no box**, since nothing sits under it.',
    '- 4 row items, each with all 6 columns as bullets.',
    '- 3 question items with headings like `## Q2. Can the rg-search-demo replicas go back to 1?`, each with its own box and no repeated text.',
    '- On submit, answers are labelled with the row or the `Q` heading.',
    'This is sample data, not real cost figures.',
  ])
  expect(missingWarning(missing)).toContain('and 4 more line(s)')
})

test('a dropped closing paragraph is reported', () => {
  expect(missingLines(sectionsSource, sectionsDraft)).toEqual([
    "This answer has three sections, so it's a good test. The file should show three items with full text under each.",
  ])
})

test('a complete file reports nothing, even with tables reshaped into bullets', () => {
  const source = `**Results**

| # | Account | Severity |
|---|---|---|
| 1 | \`prodarchive01\` | Medium |

1. Should we fix it now?`
  const md = `Add your replies under each Response: line.

## 1. prodarchive01

- #: 1
- Account: \`prodarchive01\`
- Severity: Medium

Response:

## Q1. Should we fix it now?

Response:

## Other comments
`
  expect(missingLines(source, md)).toEqual([])
  expect(missingWarning([])).toBe(null)
})

test('answer boxes grow with their text', () => {
  expect(fieldRows('', 80)).toBe(3)
  expect(fieldRows('a\nb\nc\nd', 80)).toBe(5)
  expect(fieldRows('x'.repeat(200), 80)).toBe(5)
})
