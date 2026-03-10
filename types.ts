export interface UserProfile {
  name: string;
  relationship: string;
  interests: string[];
  petNames?: string;
  dailyRoutine?: string;
  homeSituation?: string;
  conversationTastes?: string;
  thingsILike?: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR'
}