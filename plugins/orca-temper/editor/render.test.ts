// The default view renders the body as temper-ui does: headings, lists and fenced code through
// temper-design's parse and its sanitizer, which strips what a body may not carry. The sanitizer
// needs a DOM; `orca plugin test` runs in plain Node, so jsdom stands in for the frame's window.
import { JSDOM } from 'jsdom'
import { assert, test } from 'orca/testing'

// One window for every DOM test in this run: the sanitizer binds to the first window it sees.
const globals = globalThis as unknown as Record<string, unknown>
if (globals.document === undefined) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'Element', 'Node', 'DocumentFragment', 'NodeFilter', 'HTMLElement']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]
  }
}
const frameWindow = globals.window as Window & typeof globalThis
const { renderBody } = await import('./render')

function parse(html: string): Document {
  return new frameWindow.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
}

test('the default view renders headings, lists and code through the sanitizer', () => {
  const html = renderBody(
    [
      '# The body room',
      '',
      '## What to build',
      '',
      '- one press',
      '- every change in view',
      '',
      '1. first',
      '2. second',
      '',
      '```ts',
      'const held = base',
      '```',
      '',
      'Inline `code` too.'
    ].join('\n')
  )
  const doc = parse(html)
  assert.equal(doc.querySelector('h1')?.textContent, 'The body room')
  assert.equal(doc.querySelector('h2')?.textContent, 'What to build')
  assert.deepEqual(Array.from(doc.querySelectorAll('ul > li')).map((li) => li.textContent), ['one press', 'every change in view'])
  assert.equal(doc.querySelectorAll('ol > li').length, 2)
  const code = doc.querySelector('pre > code')
  assert.ok(code, 'a fenced block is a code block')
  assert.match(code.getAttribute('class') ?? '', /\bhljs\b/)
  assert.match(code.getAttribute('class') ?? '', /\blanguage-ts\b/)
  assert.equal(code.textContent, 'const held = base\n')
  assert.equal(doc.querySelector('p > code')?.textContent, 'code')
})

test('what a body may not carry is stripped or withheld, in words', () => {
  const html = renderBody(
    [
      '<script>window.ran = true</script>',
      '<p style="position:fixed" class="inset-0 hljs" onclick="steal()">styled</p>',
      '<form action="https://elsewhere.example"><button>Send</button></form>',
      '![a chart](https://elsewhere.example/chart.png)'
    ].join('\n\n')
  )
  const doc = parse(html)
  assert.equal(doc.querySelector('script'), null)
  assert.equal(doc.querySelector('form'), null)
  assert.equal(doc.querySelector('button'), null)
  const styled = Array.from(doc.querySelectorAll('p')).find((p) => p.textContent === 'styled')
  assert.ok(styled)
  assert.equal(styled.getAttribute('style'), null)
  assert.equal(styled.getAttribute('onclick'), null)
  assert.equal(styled.getAttribute('class'), 'hljs', 'only the pipeline’s own classes survive')
  assert.equal(doc.querySelector('img'), null)
  assert.match(doc.querySelector('.md-withheld')?.textContent ?? '', /remote image withheld/)
})
