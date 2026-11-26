import type { ResearchSearchDocument, ResearchSearchLocator, ResearchSearchQuery, ResearchSource } from './research';
export type AIProtocol = 'responses' | 'chat' | 'messages' | 'gemini' | 'codex';
export interface ResearchAIConfig {
  provider: string; protocol: AIProtocol; base: string; model: string; cliPath: string;
  allowRecords: boolean; sourceIds: string[]; rounds: number; tokenBudget: number;
}
export interface ResearchAISettings {
  value: ResearchAIConfig | null; hasKey: boolean; sources: ResearchSource[];
  presets: {id: string; name: string; protocol: AIProtocol; base: string; env: string}[];
}
export interface SmartCitation {
  id: string; title: string; format: ResearchSearchDocument['format']; locator: ResearchSearchLocator; snippet: string; revision?: string;
}
export interface SmartAnswer {
  status: 'complete'|'partial'|'local'; reason?: string; detail?: string; provider?: string; model?: string;
  claims: {text:string; refs:string[]}[]; gaps:string[]; citations: Record<string,SmartCitation>;
  tables:{title:string;rows:{trialId:string;date:string;ref:string;cells:{label:string;value:string;ref:string;verified?:boolean}[]}[]}[];
  results:ResearchSearchDocument[]; searches:string[]; usage:number|null; estimatedTokens?:number;
}
export type SmartQuery = Omit<ResearchSearchQuery, 'mode'>;
