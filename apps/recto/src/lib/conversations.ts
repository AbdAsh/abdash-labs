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

interface PostgrestFailure {
  message?: string
}

/** PostgREST returns a plain object rather than an Error; throwing it verbatim
 *  reaches the interface as "[object Object]". */
function dbError(what: string, error: PostgrestFailure): Error {
  return new Error(`Could not ${what}: ${error.message ?? 'the database refused the request.'}`)
}

export async function listConversations(notebookId: string): Promise<ConversationSummary[]> {
  const { data, error } = await db()
    .from('conversations')
    .select('id, title')
    .eq('notebook_id', notebookId)
    .order('created_at', { ascending: false })
  if (error) throw dbError('load this notebook’s conversations', error)
  return (data ?? []) as ConversationSummary[]
}

/**
 * Messages are stored flat, one row per role; pair them into turns for display.
 *
 * The pairing has to tolerate a question with no answer, because that is what a
 * connection dropped mid-stream leaves behind. An assistant row arriving with
 * no question before it belongs to nothing and is dropped rather than being
 * stapled onto the previous turn, which would attribute one answer to two
 * different questions.
 */
export async function loadConversation(id: string): Promise<StoredTurn[]> {
  const { data, error } = await db()
    .from('messages')
    .select('role, content, citations')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
  if (error) throw dbError('open this conversation', error)

  const turns: StoredTurn[] = []
  for (const m of (data ?? []) as {
    role: string
    content: string
    citations: Citation[] | null
  }[]) {
    if (m.role === 'user') {
      turns.push({ question: m.content, answer: '', citations: [] })
      continue
    }
    const last = turns[turns.length - 1]
    // An answer only lands on the turn it was written for — never on a turn
    // that already has one.
    if (last && last.answer === '') {
      last.answer = m.content
      last.citations = m.citations ?? []
    }
  }
  return turns
}

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await db().from('conversations').delete().eq('id', id)
  if (error) throw dbError('delete the conversation', error)
}
