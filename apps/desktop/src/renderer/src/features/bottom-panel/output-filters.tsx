import { FolderGit2Icon, RadioTowerIcon, SignalIcon, TextIcon } from 'lucide-react'

import { type FilterField } from '@/components/reui/filters/filters-types'
import {
  ACTIVITY_CHANNEL_LABELS,
  ACTIVITY_LEVEL_LABELS,
  type ActivityChannel,
  type ActivityEntry,
} from '@/state/activity'

import { ChannelTag } from './channel-mark'
import { BADGE_MENU, FACE_MENU, faceValue } from './log-search'
import { LevelBadge } from './log-table'

/**
 * The Output's Filters schema, after the audit log's in ReUI's
 * `solution-dev-ops-2`: channel, level, vault and message. The evaluator is
 * `shownEntries` in `state/activity.ts`, beside the query it reads.
 */

const CHANNELS = Object.keys(ACTIVITY_CHANNEL_LABELS) as ActivityChannel[]
const LEVELS = Object.keys(ACTIVITY_LEVEL_LABELS) as ActivityEntry['level'][]

const isChannel = (value: string): value is ActivityChannel => value in ACTIVITY_CHANNEL_LABELS
const isLevel = (value: string): value is ActivityEntry['level'] => value in ACTIVITY_LEVEL_LABELS

/** The fields, with the vaults the log has named as Vault's options. */
export function outputFilterFields(remotes: readonly string[]): FilterField[] {
  return [
    {
      id: 'channel',
      label: 'Channel',
      icon: <RadioTowerIcon aria-hidden="true" />,
      type: 'select',
      className: FACE_MENU,
      options: CHANNELS.map((channel) => ({
        value: channel,
        label: ACTIVITY_CHANNEL_LABELS[channel],
        icon: <ChannelTag channel={channel} />,
      })),
      renderValue: faceValue(
        (value) => (isChannel(value) ? <ChannelTag channel={value} /> : value),
        'any channel',
      ),
    },
    {
      id: 'level',
      label: 'Level',
      icon: <SignalIcon aria-hidden="true" />,
      type: 'select',
      className: BADGE_MENU,
      options: LEVELS.map((level) => ({
        value: level,
        label: ACTIVITY_LEVEL_LABELS[level],
        icon: (
          <span aria-hidden="true">
            <LevelBadge level={level} />
          </span>
        ),
      })),
      renderValue: faceValue(
        (value) => (isLevel(value) ? <LevelBadge level={value} /> : value),
        'any level',
      ),
    },
    {
      id: 'vault',
      label: 'Vault',
      icon: <FolderGit2Icon aria-hidden="true" />,
      type: 'select',
      searchable: true,
      className: FACE_MENU,
      options: remotes.map((remote) => ({
        value: remote,
        label: remote,
        icon: (
          <span aria-hidden="true" className="font-mono text-xs">
            {remote}
          </span>
        ),
      })),
      renderValue: faceValue(
        (value) => <span className="truncate font-mono text-xs">{value}</span>,
        'any vault',
      ),
    },
    {
      id: 'message',
      label: 'Message',
      icon: <TextIcon aria-hidden="true" />,
      type: 'text',
      placeholder: 'Pushed',
      operators: [
        { value: 'contains', label: 'contains' },
        { value: 'not_contains', label: 'excludes' },
        { value: 'starts_with', label: 'starts with' },
      ],
    },
  ]
}
