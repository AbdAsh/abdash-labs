import { supabase } from '@labs/platform'
import type { Citation } from './chat'

const db = () => supabase.schema('recto')

export interface StoredTurn {
  question: string
  answer: string
  citations: Citation[]
}

export interface ConversationSummary {
  id: string
  title: string
}

export async function listConversations(notebookId: string): Promise<ConversationSummary[]> {
  const { data, error } = await db()
    .from('conversations')
    .select('id, title')
    .eq('notebook_id', notebookId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as ConversationSummary[]
}

/** Messages are stored flat, one row per role; pair them into turns for display. */
export async function loadConversation(id: string): Promise<StoredTurn[]> {
  const { data, error } = await db()
    .from('messages')
    .select('role, content, citations')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
  if (error) throw error

  const turns: StoredTurn[] = []
  for (const m of (data ?? []) as {
    role: string
    content: string
    citations: Citation[] | null
  }[]) {
    if (m.role === 'user') {
      turns.push({ question: m.content, answer: '', citations: [] })
    } else if (turns.length) {
      const last = turns[turns.length - 1]!
      last.answer = m.content
      last.citations = m.citations ?? []
    }
  }
  return turns
}

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await db().from('conversations').delete().eq('id', id)
  if (error) throw error
}
