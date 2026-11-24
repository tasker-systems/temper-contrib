// Explore: team → context (design record, build item 8). The Explore sub-tab lists every
// context the person can read, grouped by its owner — teams by name, then the people whose
// contexts they can read — each owner a collapsed `Collapsible` holding its contexts, each
// context row carrying its ref and how many resources it homes. Nothing narrows it to "yours":
// Explore never sends `owner` (R2), as temper-ui's context page does not.
//
// A pressed context pushes the context view onto the panel's detail stack — the same view a
// place on Home opens: the context's recently updated items, each opening its record's detail,
// with Show more growing the list in place, and the search slot above them. The view is the
// same for every kind of context and assumes nothing about what one holds (R3). The search
// slot (`ContextSearchSlot`) holds Search's own region (./search.tsx), scoped to the context by
// its id — the same two groups, never `owner`.
//
// The panel never talks to temper itself: both reads go through the worker on the borrowed
// grant (`temper.explore.contexts`, `temper.context.recent`). Which owners are open is
// device-local view state, held across the panel's runs.
import {
  atom,
  Button,
  Collapsible,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  type OrcaNode
} from 'orca'
import { omissionSentence, WAY_IN_BOUND, WAY_IN_ORDER } from '../vendor/temper-design.mjs'
import { ACT_ICON, docTypeIcon, PLACE_ICON, rowDescription } from './look'
import {
  CONTEXT_RECENT_BOUND,
  WAY_IN_MAX,
  type ContextRecentOutput,
  type ExploreContext,
  type ExploreOutput,
  type ExploreOwner,
  type ResourceSummary
} from './protocol'
import { CountHeading, FailedRegion, Loading, NotConnected } from './regions'
import { resumeSearch, SearchRegion, type SearchScope } from './search'

/** A context pushed onto the detail stack: from Explore, or from a place on Home. */
export interface ContextEntry {
  kind: 'context'
  id: string
  ref: string
  name: string
}

/** Whether a stack entry is a context view rather than a record's detail. */
export function isContextEntry(entry: object): entry is ContextEntry {
  return 'kind' in entry && entry.kind === 'context'
}

/** What Explore lists, in its own words. */
export const EXPLORE_SCOPE = 'contexts you can read'
const TEAMS_ORDER = 'by name — each team with the contexts you can read in it'
const PEOPLE_ORDER = "by handle — people whose contexts you can read"

/** The contexts read's last answer; null while it is out or before it was asked. */
const exploreResult = atom<ExploreOutput | null>('explore-result', null)
/** Which owners are open, by owner ref — device-local view state. Absent is collapsed. */
const exploreOpen = atom('explore-open', {} as Record<string, boolean>, { persist: 'plugin' })

let exploreAsked = false

/** True once Explore's read was asked in this run, so a Refresh asks it again. */
export function exploreWasAsked(): boolean {
  return exploreAsked
}

/**
 * Asks for every context the person can read. A read already answered stays drawn until the new
 * answer lands; a read that never answers is Explore's failure, said in its region.
 */
export async function loadExplore(): Promise<void> {
  exploreAsked = true
  let answer: ExploreOutput
  try {
    answer = await plugin.request('temper.explore.contexts')
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the contexts read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(exploreResult, answer)
}

/** A pressed context's items answer per context id, null while its request is out. */
const contextResults = atom('context-results', {} as Record<string, ContextRecentOutput | null>)
/** How far each context's items have grown: a step of WAY_IN_BOUND at a Show-more press. */
const contextShown = atom('context-shown', {} as Record<string, number>)

function contextBound(id: string): number {
  return read(contextShown)[id] ?? CONTEXT_RECENT_BOUND
}

async function askContextRecent(id: string, bound: number): Promise<ContextRecentOutput> {
  try {
    return await plugin.request('temper.context.recent', { id, bound })
  } catch (error) {
    return {
      state: 'failed',
      message: `the context's items read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** The items read behind one pushed context, once per id — null marks the request as out. */
export async function loadContextRecent(entry: ContextEntry): Promise<void> {
  if (read(contextResults)[entry.id] !== undefined) {
    return
  }
  set(contextResults, { ...read(contextResults), [entry.id]: null })
  const answer = await askContextRecent(entry.id, contextBound(entry.id))
  set(contextResults, { ...read(contextResults), [entry.id]: answer })
}

/** Show more on a context's items: the ways-in step and cap, grown in place. */
async function showMoreContext(id: string): Promise<void> {
  const bound = Math.min(contextBound(id) + WAY_IN_BOUND, WAY_IN_MAX)
  set(contextShown, { ...read(contextShown), [id]: bound })
  const answer = await askContextRecent(id, bound)
  set(contextResults, { ...read(contextResults), [id]: answer })
}

/** "1 context", "3 contexts". */
function counted(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function contextOf(context: ExploreContext): ContextEntry {
  return { kind: 'context', id: context.id, ref: context.ref, name: context.name }
}

/** One owner: collapsed by default, its contexts and what they home said before it opens. */
function OwnerGroup(props: { owner: ExploreOwner; onOpenContext: (entry: ContextEntry) => void }) {
  const owner = props.owner
  const resources = owner.contexts.reduce((sum, context) => sum + context.resourceCount, 0)
  const open = read(exploreOpen)[owner.ownerRef] === true
  return (
    <Collapsible
      title={owner.ownerRef}
      description={`${owner.kind} · ${counted(owner.contexts.length, 'context')} · ${counted(resources, 'resource')}`}
      open={open}
      onChange={(next) => set(exploreOpen, { ...read(exploreOpen), [owner.ownerRef]: next })}
    >
      <List label={owner.ownerRef}>
        {owner.contexts.map((context) => (
          <ListItem
            key={context.id}
            title={context.name}
            icon={PLACE_ICON}
            description={`${context.ref} · ${counted(context.resourceCount, 'resource')}`}
            onPress={() => props.onOpenContext(contextOf(context))}
          />
        ))}
      </List>
    </Collapsible>
  )
}

/** One group of owners — the teams, or the people — its count a badge, its order stated. */
function OwnerSection(props: {
  label: string
  order: string
  owners: ExploreOwner[]
  onOpenContext: (entry: ContextEntry) => void
}) {
  return (
    <Stack gap="sm">
      <CountHeading label={props.label} count={props.owners.length} />
      <Text muted size="xs">
        {props.order}
      </Text>
      {props.owners.length === 0 ? (
        <Text muted size="xs">{`— No ${props.label} with ${EXPLORE_SCOPE}.`}</Text>
      ) : (
        <Stack gap="xs">
          {props.owners.map((owner) => (
            <OwnerGroup key={owner.ownerRef} owner={owner} onOpenContext={props.onOpenContext} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * The Explore sub-tab: teams, each with its contexts, then the people whose contexts the person
 * can read — in every region state. The panel draws nothing here while its own refusal stands.
 */
export function ExploreTab(props: { onOpenContext: (entry: ContextEntry) => void }): OrcaNode {
  const answer = read(exploreResult)
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Heading level={3}>teams</Heading>
        <Loading words="◌ Loading teams…" />
      </Stack>
    )
  }
  if (answer.state === 'not-connected') {
    return <NotConnected message={answer.message} />
  }
  if (answer.state === 'failed') {
    return <FailedRegion label="teams" message={answer.message} />
  }
  if (answer.contextCount === 0) {
    return (
      <Stack gap="sm">
        <CountHeading label="teams" count={0} />
        <Text muted size="xs">{`— No ${EXPLORE_SCOPE}.`}</Text>
      </Stack>
    )
  }
  const teams = answer.owners.filter((owner) => owner.kind === 'team')
  const people = answer.owners.filter((owner) => owner.kind === 'person')
  return (
    <Stack gap="md">
      <OwnerSection label="teams" order={TEAMS_ORDER} owners={teams} onOpenContext={props.onOpenContext} />
      {people.length === 0 ? undefined : (
        <OwnerSection label="people" order={PEOPLE_ORDER} owners={people} onOpenContext={props.onOpenContext} />
      )}
      <Text muted size="xs">
        {omissionSentence(answer.contextCount, answer.contextCount, EXPLORE_SCOPE)}
      </Text>
    </Stack>
  )
}

/** A context as Search scopes to it: by its id, its ref the words the region says. */
function searchScopeOf(context: ContextEntry): SearchScope {
  return { kind: 'context', id: context.id, ref: context.ref }
}

/** A context view's search owes the question it held on an earlier run. */
export function resumeContextSearch(context: ContextEntry): void {
  resumeSearch(searchScopeOf(context))
}

/** The context view's search slot: Search's own region, scoped to this context by its id. */
export function ContextSearchSlot(props: {
  context: ContextEntry
  onOpenItem: (item: ResourceSummary) => void
}): OrcaNode {
  return (
    <Stack gap="sm">
      <Heading level={3}>search in this context</Heading>
      <SearchRegion scope={searchScopeOf(props.context)} onOpenItem={props.onOpenItem} />
    </Stack>
  )
}

/** A context's recently updated items, in every region state, Show more growing them in place. */
function ContextRecentRegion(props: {
  context: ContextEntry
  onOpenItem: (item: ResourceSummary) => void
}) {
  const label = 'recently updated'
  const scope = `resources in ${props.context.ref}`
  const answer = read(contextResults)[props.context.id] ?? null
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Heading level={3}>{label}</Heading>
        <Loading words={`◌ Loading ${label}…`} />
      </Stack>
    )
  }
  if (answer.state === 'not-connected') {
    return <NotConnected message={answer.message} />
  }
  if (answer.state === 'failed') {
    return <FailedRegion label={label} message={answer.message} />
  }
  return (
    <Stack gap="sm">
      <CountHeading label={label} count={answer.total} />
      <Text muted size="xs">
        {WAY_IN_ORDER}
      </Text>
      {answer.rows.length === 0 ? (
        <Text muted size="xs">{`— No ${scope}.`}</Text>
      ) : (
        <List label={label}>
          {answer.rows.map((item) => (
            <ListItem
              key={item.id}
              title={item.title}
              icon={docTypeIcon(item.docType)}
              description={rowDescription(item.docType, item.stage)}
              onPress={() => props.onOpenItem(item)}
            />
          ))}
        </List>
      )}
      {answer.rows.length === 0 ? undefined : (
        <Text muted size="xs">
          {omissionSentence(answer.total, answer.rows.length, scope)}
        </Text>
      )}
      {answer.rows.length < answer.total && answer.bound < WAY_IN_MAX ? (
        <Row>
          <Button
            variant="ghost"
            size="sm"
            icon={ACT_ICON.showMore}
            onPress={() => void showMoreContext(props.context.id)}
          >
            Show more
          </Button>
        </Row>
      ) : undefined}
    </Stack>
  )
}

/**
 * A pushed context: Back, the word "context" over its name and ref, the search slot, then its
 * recently updated items — the same for every kind of context (R3).
 */
export function ContextView(props: {
  entry: ContextEntry
  onBack: () => void
  onOpenItem: (item: ResourceSummary) => void
}): OrcaNode {
  return (
    <Stack gap="md">
      <Row>
        <Button variant="ghost" size="sm" onPress={props.onBack}>
          Back
        </Button>
      </Row>
      <Stack gap="xs">
        <Text muted size="xs">
          context
        </Text>
        <Heading level={2}>{props.entry.name}</Heading>
        <Text muted size="xs">
          {props.entry.ref}
        </Text>
      </Stack>
      <ContextSearchSlot context={props.entry} onOpenItem={props.onOpenItem} />
      <ContextRecentRegion context={props.entry} onOpenItem={props.onOpenItem} />
    </Stack>
  )
}
