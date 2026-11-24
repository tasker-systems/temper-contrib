// The region states every view of the rail draws in the same words (the look design's
// "Refusals and empty states", ruling 21): still out — the house words over a skeleton;
// failed — a warning callout titled "<label> unavailable — nothing here was read."; signed
// out — the empty state with the plug; and a region's heading with its count as a badge.
// Home, a record's detail and Explore all draw them from here, so no view words them its own way.
import { Badge, Callout, EmptyState, Heading, Skeleton, Stack, Text } from 'orca'

/** Signed out: temper was never reached. `plug` says connection; the words say the rest. */
export function NotConnected(props: { message: string }) {
  return <EmptyState title="temper is not connected" description={props.message} icon="plug" />
}

/** A read still out: its house words, muted, with the skeleton of what will stand there. */
export function Loading(props: { words: string }) {
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        {props.words}
      </Text>
      <Skeleton lines={3} label={props.words} />
    </Stack>
  )
}

/**
 * A read that failed: a warning callout whose title is the house words — what is unavailable,
 * and that nothing here was read — and whose body is the message; the callout draws its own
 * glyph, so the words carry no "⚠" (Rulings 21.3).
 */
export function Unavailable(props: { title: string; message: string }) {
  return (
    <Callout tone="warning" title={props.title}>
      <Text muted size="xs">
        {props.message}
      </Text>
    </Callout>
  )
}

/** A region whose read failed: its label, then what failed; nothing stands in its place. */
export function FailedRegion(props: { label: string; message: string }) {
  return (
    <Stack gap="xs">
      <Heading level={3}>{props.label}</Heading>
      <Unavailable title={`${props.label} unavailable — nothing here was read.`} message={props.message} />
    </Stack>
  )
}

/** A region's heading: its label, its count a badge beside it. */
export function CountHeading(props: { label: string; count: number }) {
  return (
    <Heading level={3}>
      {props.label} <Badge>{String(props.count)}</Badge>
    </Heading>
  )
}
