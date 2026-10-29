import { describe, expect, it } from 'vitest'

import {
  boardFor,
  isScoresPath,
  parsePlayerScores,
  recordRun,
  scoresPath,
  serializePlayerScores,
  slowerMode,
  type PlayerScores,
} from '../scoreboard'

const me = { login: 'Billy', name: 'Billy K' }

describe('the arcade scoreboard', () => {
  it('keeps one file per player under .holi', () => {
    expect(scoresPath('Billy')).toBe('.holi/arcade/scores/billy.json')
    expect(isScoresPath('.holi/arcade/scores/billy.json')).toBe(true)
    expect(isScoresPath('.holi/arcade/scores/x/billy.json')).toBe(false)
    expect(isScoresPath('notes/billy.json')).toBe(false)
  })

  it('records a first run and only ever a better one', () => {
    const first = recordRun(null, me, 'mid', 12, '2026-10-23T10:00:00Z')
    expect(first).toEqual({
      login: 'Billy',
      name: 'Billy K',
      best: { mid: { score: 12, at: '2026-10-23T10:00:00Z' } },
    })
    expect(recordRun(first, me, 'mid', 12, 'later')).toBeNull()
    expect(recordRun(first, me, 'mid', 5, 'later')).toBeNull()
    expect(recordRun(first, me, 'mid', 0, 'later')).toBeNull()
    const better = recordRun(first, me, 'hard', 3, 't2')
    expect(better?.best).toEqual({
      mid: { score: 12, at: '2026-10-23T10:00:00Z' },
      hard: { score: 3, at: 't2' },
    })
  })

  it('round-trips a file and drops a broken one', () => {
    const scores: PlayerScores = {
      login: 'ana',
      best: { low: { score: 4, at: 't' } },
    }
    expect(parsePlayerScores(serializePlayerScores(scores))).toEqual(scores)
    expect(parsePlayerScores('{')).toBeNull()
    expect(parsePlayerScores('{"best":{}}')).toBeNull()
    expect(
      parsePlayerScores('{"login":"x","best":{"mid":{"score":-1},"fast":{"score":9}}}'),
    ).toEqual({ login: 'x', best: {} })
  })

  it('ranks a speed highest first, the earlier run winning a tie', () => {
    const players: PlayerScores[] = [
      { login: 'a', best: { mid: { score: 10, at: '2' } } },
      { login: 'b', best: { mid: { score: 20, at: '3' } } },
      { login: 'c', best: { mid: { score: 10, at: '1' } } },
      { login: 'd', best: { hard: { score: 99, at: '1' } } },
    ]
    expect(boardFor(players, 'mid').map((row) => row.login)).toEqual(['b', 'c', 'a'])
  })

  it('counts a run at the slowest speed it was played at', () => {
    expect(slowerMode('hard', 'low')).toBe('low')
    expect(slowerMode('mid', 'hard')).toBe('mid')
  })
})
