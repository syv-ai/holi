import { describe, expect, it } from 'vitest'
import { createOpenIntentQueue, type OpenIntent } from '../src/main/open-intents'

const open = (remote: string, path: string, focus?: false): OpenIntent => ({
  channel: 'vault:open',
  remote,
  path,
  ...(focus === undefined ? {} : { focus }),
})
const navigate = (remote: string, name: string): OpenIntent => ({
  channel: 'vault:navigate',
  remote,
  plugin: 'agent',
  name,
  payload: null,
})

function setup() {
  const sent: OpenIntent[] = []
  const queue = createOpenIntentQueue()
  const dispatch = (intent: OpenIntent) => sent.push(intent)
  return { queue, sent, dispatch }
}

describe('open intent queue', () => {
  it('drains notification navigation before a newer document open', () => {
    const { queue, sent, dispatch } = setup()
    queue.send(navigate('ada/old', 'old-notification'), false, dispatch)
    queue.send(open('ada/new', 'new.md', false), false, dispatch)

    queue.drain(dispatch)

    expect(sent).toEqual([
      navigate('ada/old', 'old-notification'),
      open('ada/new', 'new.md', false),
    ])
  })

  it('drains document open before a newer notification navigation in a rapid sequence', () => {
    const { queue, sent, dispatch } = setup()
    queue.send(open('ada/old', 'old.md'), false, dispatch)
    queue.send(navigate('ada/new', 'new-notification'), false, dispatch)
    queue.send(open('ada/newest', 'newest.md'), false, dispatch)

    queue.drain(dispatch)
    queue.drain(dispatch)

    expect(sent).toEqual([
      open('ada/old', 'old.md'),
      navigate('ada/new', 'new-notification'),
      open('ada/newest', 'newest.md'),
    ])
  })

  it('sends ready intents immediately and does not redeliver them when draining held intents', () => {
    const { queue, sent, dispatch } = setup()
    queue.send(open('ada/held', 'held.md'), false, dispatch)
    queue.send(navigate('ada/ready', 'ready-notification'), true, dispatch)
    queue.drain(dispatch)
    queue.drain(dispatch)

    expect(sent).toEqual([navigate('ada/ready', 'ready-notification'), open('ada/held', 'held.md')])
  })
})
