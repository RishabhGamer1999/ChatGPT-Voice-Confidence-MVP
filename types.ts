
export interface TranscriptItem {
  id: string;
  type: 'hinglish' | 'english' | 'hindi';
  spoken: string;
  displayed: string;
  translation: string;
  confidence: number;
  timestamp: string;
  isAI?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  isVoice?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  timestamp: number;
}

export enum SessionState {
  IDLE = 'idle',
  LISTENING = 'listening',
  PROCESSING = 'processing',
  PAUSED = 'paused',
  ENDED = 'ended',
  ERROR = 'error'
}

export interface UIConfig {
  ccOn: boolean;
  isPrivacyMode: boolean;
}
