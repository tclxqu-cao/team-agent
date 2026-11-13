// ── Infrastructure Layer ──
// Concrete implementations of domain interfaces
export { compoundTileEncodingCost, compoundPngBytes, encodeCompoundTiles, decodeCompoundTiles } from './live-view/compound-video-wire.js';
export type { CompoundWireFormat, CompoundWireTile, BinaryCompoundTiles } from './live-view/compound-video-wire.js';

export { SQLiteDatabase, getDatabase } from './SQLiteDatabase.js';
export { SQLiteSettingsStore } from './SQLiteSettingsStore.js';
export { SQLiteSessionStore } from './SQLiteSessionStore.js';
export { SQLiteParallelSessionStore } from './SQLiteParallelSessionStore.js';
export { SQLiteMemoryStore } from './SQLiteMemoryStore.js';
export { SQLiteMCPServerStore } from './SQLiteMCPServerStore.js';
export { SQLiteSkillStore } from './SQLiteSkillStore.js';
export { SQLitePluginStore } from './SQLitePluginStore.js';
export { SQLiteUploadStore } from './SQLiteUploadStore.js';
export { SQLiteProjectStore } from './SQLiteProjectStore.js';
export { SQLiteThreadGoalStore } from './SQLiteThreadGoalStore.js';
export { FileThreadGoalStore } from './FileThreadGoalStore.js';
export { SQLiteAgentStore } from './SQLiteAgentStore.js';
export { SQLiteLSPServerStore } from './SQLiteLSPServerStore.js';
export { SQLiteRemoteToolStore } from './SQLiteRemoteToolStore.js';
export { SQLiteEngineSwitchRepository } from './SQLiteEngineSwitchRepository.js';
export { SQLiteAuthStore } from './SQLiteAuthStore.js';
export { SQLiteAnonymousWebStore, type AnonymousWebPrincipal } from './SQLiteAnonymousWebStore.js';
export { SQLiteWebConsoleStore } from './SQLiteWebConsoleStore.js';
export { SQLiteToolExecutionPolicyStore } from './SQLiteToolExecutionPolicyStore.js';
export {
  HostPathError,
  HostPathPolicy,
  isPathInsideRoot,
  type HostDirectoryEntry,
  type HostPathErrorCode,
} from './HostPathPolicy.js';
export {
  DailyFileLogger,
  configureGlobalLogger,
  flushGlobal,
  getGlobalLogger,
  installGlobalLogging,
  logGlobal,
  resetGlobalLoggerForTests,
  type DailyFileLoggerOptions,
  type GlobalErrorHandlersHandle,
  type GlobalErrorHandlersOptions,
  type InstallGlobalLoggingOptions,
  type LogEntry,
  type LogLevel,
} from './logger/DailyFileLogger.js';
