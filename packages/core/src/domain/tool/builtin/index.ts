export { ReadFileTool } from './ReadFileTool.js';
export { WriteFileTool } from './WriteFileTool.js';
export { StrReplaceTool } from './StrReplaceTool.js';
export { BashTool } from './BashTool.js';
export { WebFetchTool } from './WebFetchTool.js';
export { WebSearchTool } from './WebSearchTool.js';
export { GrepTool } from './GrepTool.js';
export { GlobTool } from './GlobTool.js';
export { TodoAddTool, TodoUpdateTool, TodoListTool } from './TodoTool.js';
export { DispatchAgentTool, type DispatchResult } from './DispatchAgentTool.js';
export { WaitAgentTool } from './WaitAgentTool.js';
export { AskUserTool, type AskUserRequest, type AskUserResponse, type AskUserCallback } from './AskUserTool.js';
export { CronCreateTool, CronDeleteTool, CronListTool } from './CronTools.js';
export { ApplyPatchTool } from './ApplyPatchTool.js';
export { LspDiagnosticsTool, LspHoverTool, LspDefinitionTool, LspReferencesTool } from './LspTools.js';
export { ShowWidgetTool } from './ShowWidgetTool.js';
export { KidEarthCourseTool } from './KidEarthCourseTool.js';
export { RemoteProjectActionTool } from './RemoteProjectActionTool.js';

import { ApplyPatchTool } from './ApplyPatchTool.js';
import { ReadFileTool } from './ReadFileTool.js';
import { WriteFileTool } from './WriteFileTool.js';
import { StrReplaceTool } from './StrReplaceTool.js';
import { BashTool } from './BashTool.js';
import { WebFetchTool } from './WebFetchTool.js';
import { WebSearchTool } from './WebSearchTool.js';
import { GrepTool } from './GrepTool.js';
import { GlobTool } from './GlobTool.js';
import { ShowWidgetTool } from './ShowWidgetTool.js';
import type { IToolRegistry } from '../entities.js';

export function registerBuiltinTools(registry: IToolRegistry): void {
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new StrReplaceTool());
  registry.register(new BashTool());
  registry.register(new WebFetchTool());
  registry.register(new WebSearchTool());
  registry.register(new GrepTool());
  registry.register(new GlobTool());
  registry.register(new ApplyPatchTool());
  registry.register(new ShowWidgetTool());
}
