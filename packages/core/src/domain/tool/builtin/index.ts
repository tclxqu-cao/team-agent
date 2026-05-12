export { ReadFileTool } from './ReadFileTool.js';
export { WriteFileTool } from './WriteFileTool.js';
export { BashTool } from './BashTool.js';
export { WebFetchTool } from './WebFetchTool.js';
export { WebSearchTool } from './WebSearchTool.js';
export { GrepTool } from './GrepTool.js';
export { TodoAddTool, TodoUpdateTool, TodoListTool } from './TodoTool.js';
export { DispatchAgentTool } from './DispatchAgentTool.js';
export { CronCreateTool, CronDeleteTool, CronListTool } from './CronTools.js';

import { ReadFileTool } from './ReadFileTool.js';
import { WriteFileTool } from './WriteFileTool.js';
import { BashTool } from './BashTool.js';
import { WebFetchTool } from './WebFetchTool.js';
import { WebSearchTool } from './WebSearchTool.js';
import { GrepTool } from './GrepTool.js';
import type { IToolRegistry } from '../entities.js';

export function registerBuiltinTools(registry: IToolRegistry): void {
  registry.register(new ReadFileTool());
  registry.register(new WriteFileTool());
  registry.register(new BashTool());
  registry.register(new WebFetchTool());
  registry.register(new WebSearchTool());
  registry.register(new GrepTool());
}
