import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'reply-sheet',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const
const GLYPH = '\u{F03EB}' // the pencil on "Respond here"

test('icons are on by default', async $ => {
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'here' }))?.text).toBe(`${GLYPH} Respond here`)
  await ui.unmount()
})

test('icons "on" shows the glyph in any terminal', { options: { icons: 'on' } }, async $ => {
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'here' }))?.text).toBe(`${GLYPH} Respond here`)
  await ui.unmount()
})

test('icons "off" shows plain text', { options: { icons: 'off' } }, async $ => {
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Button', key: 'here' }))?.text).toBe('Respond here')
  await ui.unmount()
})
