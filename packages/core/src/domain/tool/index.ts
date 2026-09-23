export {
  type ToolContext,
  type ITool,
  type ToolResult,
  type IToolRegistry,
  type IToolExecutor,
  type ToolAuthorizationPolicy,
} from './entities.js';
export {
  TOOL_PERMISSION_MODES,
  TOOL_APPROVAL_OPTIONS,
  normalizeToolPermissionMode,
  isToolPermissionMode,
  toolApprovalDecisionFromAnswer,
  classifyToolPermission,
  ToolPermissionGate,
  PermissionAwareToolExecutor,
  type ToolPermissionMode,
  type ToolApprovalDecision,
  type ToolPermissionRequest,
  type ToolPermissionClassification,
  type ToolPermissionGateOptions,
} from './permissions.js';
