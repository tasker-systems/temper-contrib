// Search (design record, build item 9): one question, asked of everything the person can read
// or of one context — the Search sub-tab asks the first, a context view the second, through the
// same region. No "yours" narrowing rides either: the read never sends `owner` (R2).
//
// The answer comes in two groups that are never merged — **exact** (the words matched) and **by
// meaning** (the idea matched) — each its own list in its own order, each saying in temper-
// design's sentences whether more matched past what it shows (`truncated`), and the by-meaning
// group saying what it ranked from (an exhaustive read, or a draw of the nearest passages). A
// resource both arms found stands in both. When the server could not embed the words
// (`wide.degraded`), the by-meaning group is a warning callout, never an empty list that reads
// like an answer; the exact group stands unaffected beside it.
//
// An empty query asks nothing. The panel never talks to temper itself: the read goes through the
// worker on the borrowed grant (`temper.search`). The last question asked in each scope is
// device-local view state, held across the panel's runs, so a run that reopens owes its read.
import { atom, Callout, Heading, Input, List, ListItem, plugin, read, set, Stack, Text, type OrcaNode } from 'orca'
import { drawnSentence, uncountedSentence } from '../vendor/temper-design.mjs'
import { docTypeIcon, rowDescription } from './look'
import type { ResourceSummary, SearchArm, SearchOutput, WideSearchArm } from './protocol'
import { CountHeading, FailedRegion, Loading, NotConnected } from './regions'

/** Where a search looks: everything the person can read, or one context. */
export type SearchScope = { kind: 'everything' } | { kind: 'context'; id: string; ref: string }

export const EVERYTHING: SearchScope = { kind: 'everything' }

/** What a scope covers, in words. */
const EVERYTHING_SCOPE = 'everything you can read'

/** Each arm in reader terms: what kind of answer it gave (temper-ui's palette words). */
const EXACT_LABEL = 'exact'
const WIDE_LABEL = 'by meaning'
const EXACT_WORDS = 'matching these words'
const WIDE_WORDS = 'similar in meaning'
const EXACT_ORDER = 'matching these words — closest match first'
const WIDE_ORDER = 'similar in meaning — closest first'

/** The callout's title when the meaning arm could not run (temper-ui's words). */
export const DEGRADED_TITLE = "Meaning-match couldn't run just now"

function scopeKey(scope: SearchScope): string {
  return scope.kind === 'everything' ? 'everything' : `context:${scope.id}`
}

function scopeWords(scope: SearchScope): string {
  return scope.kind === 'everything' ? EVERYTHING_SCOPE : scope.ref
}

/** The last question asked in each scope, by scope key — device-local view state. */
const searchAsked = atom('search-asked', {} as Record<string, string>, { persist: 'plugin' })
/** What the field holds in each scope, before Enter asks it. */
const searchDraft = atom('search-draft', {} as Record<string, string>)
/** Each scope's answer; null while its request is out, absent before it was asked. */
const searchResults = atom('search-results', {} as Record<string, SearchOutput | null>)

/** Each scope's newest ask: an answer to an older question never lands over a newer one. */
const searchAsks: Record<string, number> = {}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * Asks the person's words in a scope. Empty words ask nothing: the held question and its answer
 * clear, and the region says what it would search.
 */
export async function submitSearch(scope: SearchScope, words: string): Promise<void> {
  const key = scopeKey(scope)
  const query = words.trim()
  const ask = (searchAsks[key] ?? 0) + 1
  searchAsks[key] = ask
  if (query === '') {
    set(searchAsked, without(read(searchAsked), key))
    set(searchResults, without(read(searchResults), key))
    return
  }
  set(searchAsked, { ...read(searchAsked), [key]: query })
  set(searchResults, { ...read(searchResults), [key]: null })
  let answer: SearchOutput
  try {
    answer = await plugin.request(
      'temper.search',
      scope.kind === 'everything' ? { query } : { query, contextId: scope.id }
    )
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the search never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (searchAsks[key] === ask) {
    set(searchResults, { ...read(searchResults), [key]: answer })
  }
}

/**
 * The question a scope holds from an earlier run, asked again when it has no answer here — or
 * always, on a Refresh. A scope holding no question asks nothing.
 */
export function resumeSearch(scope: SearchScope, options: { again?: boolean } = {}): void {
  const key = scopeKey(scope)
  const held = read(searchAsked)[key]
  if (held === undefined) {
    return
  }
  if (options.again === true || read(searchResults)[key] === undefined) {
    void submitSearch(scope, held)
  }
}

/** True once the everything scope was asked in this run, so a Refresh asks it again. */
export function everythingWasAsked(): boolean {
  return scopeKey(EVERYTHING) in read(searchResults)
}

/**
 * An arm's omission sentence, from the arm's own word (temper-ui's palette rule): the exact
 * arm's `truncated` false means nothing more matched; the meaning arm's means that only after an
 * exhaustive read, and a read ranked from the nearest passages says so and is never "all". An
 * arm that does not say is "not reported", never "more" inferred from a full page.
 */
function armSentence(arm: SearchArm, words: string, draw: WideSearchArm['draw'] | 'exact'): string {
  const scope = `${arm.rows.length === 1 ? 'result' : 'results'} ${words}`
  const more = arm.truncated
  if (more === null) {
    return uncountedSentence(arm.rows.length, scope, null)
  }
  if (draw === 'exact' || draw?.kind === 'exhaustive') {
    return uncountedSentence(arm.rows.length, scope, { more })
  }
  if (draw?.kind === 'nearest') {
    return drawnSentence(arm.rows.length, scope, { more, draw: draw.chunks, of: 'nearest passages' })
  }
  return uncountedSentence(arm.rows.length, scope, more ? { more } : null)
}

/** An arm with no rows, in words that say why — never a bare zero. */
function emptyWords(arm: SearchArm, words: string): string {
  if (arm.reason === 'out_of_scope') {
    return '— No phrasing will reach this — the answer is not inside what you can read.'
  }
  return `— No results ${words} — try different words.`
}

/** One arm as its own group: heading and count, its order, its rows, its omission sentence. */
function ArmGroup(props: {
  label: string
  words: string
  order: string
  arm: SearchArm
  draw: WideSearchArm['draw'] | 'exact'
  onOpenItem: (item: ResourceSummary) => void
}) {
  const arm = props.arm
  return (
    <Stack gap="sm">
      <CountHeading label={props.label} count={arm.rows.length} />
      <Text muted size="xs">
        {props.order}
      </Text>
      {arm.rows.length === 0 ? (
        arm.truncated === true ? undefined : (
          <Text muted size="xs">
            {emptyWords(arm, props.words)}
          </Text>
        )
      ) : (
        <List label={props.label}>
          {arm.rows.map((item) => (
            <ListItem
              key={item.id}
              title={item.title}
              icon={docTypeIcon(item.docType)}
              description={
                item.contextRef === null
                  ? rowDescription(item.docType, item.stage)
                  : `${rowDescription(item.docType, item.stage)} · ${item.contextRef}`
              }
              onPress={() => props.onOpenItem(item)}
            />
          ))}
        </List>
      )}
      {arm.rows.length === 0 && arm.truncated !== true ? undefined : (
        <Text muted size="xs">
          {armSentence(arm, props.words, props.draw)}
        </Text>
      )}
    </Stack>
  )
}

/** The meaning arm could not run: said as a warning, and no list stands as its answer. */
function DegradedGroup() {
  return (
    <Stack gap="sm">
      <Heading level={3}>{WIDE_LABEL}</Heading>
      <Callout tone="warning" title={DEGRADED_TITLE}>
        <Text muted size="xs">
          Exact matches only — nothing was read by meaning, so nothing here says what would match.
        </Text>
      </Callout>
    </Stack>
  )
}

/** The answer below the field, in every region state. */
function SearchAnswer(props: { scope: SearchScope; onOpenItem: (item: ResourceSummary) => void }) {
  const key = scopeKey(props.scope)
  const results = read(searchResults)
  if (!(key in results)) {
    return (
      <Text muted size="xs">
        {`Type words and press Enter to search ${scopeWords(props.scope)} — exact matches and matches by meaning, each said apart.`}
      </Text>
    )
  }
  const answer = results[key] ?? null
  if (answer === null) {
    return <Loading words="◌ Loading search results…" />
  }
  if (answer.state === 'not-connected') {
    return <NotConnected message={answer.message} />
  }
  if (answer.state === 'failed') {
    return <FailedRegion label="search" message={answer.message} />
  }
  return (
    <Stack gap="md">
      <Text muted size="xs">
        {`Results for “${answer.query}” in ${scopeWords(props.scope)}.`}
      </Text>
      <ArmGroup
        label={EXACT_LABEL}
        words={EXACT_WORDS}
        order={EXACT_ORDER}
        arm={answer.exact}
        draw="exact"
        onOpenItem={props.onOpenItem}
      />
      {answer.wide.degraded ? (
        <DegradedGroup />
      ) : (
        <ArmGroup
          label={WIDE_LABEL}
          words={WIDE_WORDS}
          order={WIDE_ORDER}
          arm={answer.wide}
          draw={answer.wide.draw}
          onOpenItem={props.onOpenItem}
        />
      )}
    </Stack>
  )
}

/** The search field and its answer, for one scope. Enter asks; an empty field asks nothing. */
export function SearchRegion(props: { scope: SearchScope; onOpenItem: (item: ResourceSummary) => void }): OrcaNode {
  const key = scopeKey(props.scope)
  const value = read(searchDraft)[key] ?? read(searchAsked)[key] ?? ''
  return (
    <Stack gap="sm">
      <Input
        type="search"
        label={props.scope.kind === 'everything' ? 'search everything' : `search ${props.scope.ref}`}
        labelHidden
        placeholder={props.scope.kind === 'everything' ? 'Search everything you can read' : `Search ${props.scope.ref}`}
        value={value}
        onChange={(next) => set(searchDraft, { ...read(searchDraft), [key]: next })}
        onSubmit={(words) => void submitSearch(props.scope, words)}
      />
      <SearchAnswer scope={props.scope} onOpenItem={props.onOpenItem} />
    </Stack>
  )
}
