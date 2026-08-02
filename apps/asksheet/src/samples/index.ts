import saasRevenue from './saas-revenue.csv?raw'
import supportTickets from './support-tickets.csv?raw'

export interface Sample {
  id: string
  name: string
  description: string
  rows: number
  csv: string
  /** Starter questions, so a visitor never faces an empty prompt box. */
  questions: string[]
}

/**
 * Two bundled datasets, because a portfolio visitor will not go and find a CSV.
 * They ship inside the bundle rather than being fetched, which keeps "nothing
 * about your data touches the network" literally true even for the demo path.
 */
export const SAMPLES: Sample[] = [
  {
    id: 'saas-revenue',
    name: 'SaaS revenue',
    description: '24 months of MRR by region, plan and contract type. One month is not like the others.',
    rows: 219,
    csv: saasRevenue,
    questions: [
      'Which month had the highest revenue and why is it an outlier?',
      'Show monthly revenue as a line chart',
      'Which region grew fastest between 2024 and 2025?',
      'What is net customer growth by plan?',
    ],
  },
  {
    id: 'support-tickets',
    name: 'Support tickets',
    description: '320 tickets with timestamps, categories, response times and a few still open.',
    rows: 320,
    csv: supportTickets,
    questions: [
      'Which category takes longest to resolve?',
      'Median first response time by priority',
      'How many tickets are still open?',
      'Does reopening a ticket hurt satisfaction?',
    ],
  },
]

export function findSample(id: string): Sample | undefined {
  return SAMPLES.find((sample) => sample.id === id)
}
