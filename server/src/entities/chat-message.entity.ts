import type { MessageRole } from '../enums/message-role.enum.js';

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  sequence_number: number;
  metadata: Record<string, unknown>;
  created_at: string;
}