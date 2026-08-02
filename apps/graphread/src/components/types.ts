import type { EntityType } from '../lib/validate'

/**
 * One colour per entity type. Chosen to stay distinguishable at 6 px on a dark
 * canvas, which is what a node in a hundred-node graph actually is.
 */
export const TYPE_COLORS: Record<EntityType, string> = {
  person: '#f2a25c',
  organization: '#6fb1f0',
  place: '#5fcfa0',
  concept: '#b79bf0',
  event: '#f07f9e',
  artifact: '#e5d267',
  date: '#9aa3b0',
}

export const TYPE_LABELS: Record<EntityType, string> = {
  person: 'People',
  organization: 'Organizations',
  place: 'Places',
  concept: 'Concepts',
  event: 'Events',
  artifact: 'Artifacts',
  date: 'Dates',
}
