/**
 * Mødelokale Booking's renderer side: the Mødelokale Booking section of the settings tab,
 * which shows and changes this machine's sign-in. `Booking.local.app` opens
 * through the vault apps plugin like any app folder.
 */
import { DoorOpen } from 'lucide-react'
import type { RendererPlugin } from '@/plugin-api'
import { BOOKING_INFO } from '../info'
import { BookingSection } from './booking-section'

export const bookingRenderer: RendererPlugin = {
  info: BOOKING_INFO,
  settingsSections: [
    {
      id: 'room-booking',
      label: 'Mødelokale Booking',
      icon: DoorOpen,
      description: 'Your sign-in to the office’s room booking site, on this machine.',
      headings: [],
      // Nothing in the vault: the sign-in is the machine's, held by main.
      files: [],
      Component: BookingSection,
    },
  ],
}
