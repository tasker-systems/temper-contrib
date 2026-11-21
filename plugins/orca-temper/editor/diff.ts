// The difference between the held base and the working text, by line: what the tab shows as
// "changes from the base". Myers' O(ND) shortest edit script, so a body with a few changes costs
// little however long it is. Pure: no DOM, no Orca, so the frame and the tests share it.

/** One line of the difference: kept, added in the working text, or removed from the base. */
export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface LineDiff {
  lines: DiffLine[]
  added: number
  removed: number
}

/** Lines as an editor counts them: a trailing newline ends the last line, it opens no new one. */
function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

/** The line difference from `base` to `working`. */
export function diffLines(base: string, working: string): LineDiff {
  const a = splitLines(base)
  const b = splitLines(working)
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Array<number>(2 * max + 3).fill(0)
  const trace: number[][] = []

  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }

  // Walk the trace back from the end, collecting the script in reverse.
  const reversed: DiffLine[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d] ?? []
    const k = x - y
    const fromBelow = k === -d || (k !== d && (row[offset + k - 1] ?? 0) < (row[offset + k + 1] ?? 0))
    const prevK = fromBelow ? k + 1 : k - 1
    const prevX = row[offset + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      reversed.push({ kind: 'same', text: a[x - 1] ?? '' })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ kind: 'added', text: b[y - 1] ?? '' })
      } else {
        reversed.push({ kind: 'removed', text: a[x - 1] ?? '' })
      }
    }
    x = prevX
    y = prevY
  }
  const lines = reversed.reverse()
  return {
    lines,
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length
  }
}

/** "No changes from the base", or how many lines were added and removed. */
export function changeWords(diff: LineDiff): string {
  if (diff.added === 0 && diff.removed === 0) {
    return 'No changes from the base'
  }
  const count = (value: number, word: string) => `${value} line${value === 1 ? '' : 's'} ${word}`
  const parts = [
    ...(diff.added > 0 ? [count(diff.added, 'added')] : []),
    ...(diff.removed > 0 ? [count(diff.removed, 'removed')] : [])
  ]
  return `${parts.join(', ')} since the base`
}
