import { z } from "zod";

const finiteNumber = z.number().finite();
const coordinate = finiteNumber.nonnegative();
const revision = z.string().min(1).max(128);
const nodeId = z.string().min(1).max(256);
const button = z.enum(["left", "right", "middle"]).optional();

const observeActionSchema = z.object({ action: z.literal("observe") }).strict();
const pressActionSchema = z.object({
  action: z.literal("press"),
  revision,
  nodeId,
}).strict();
const nodeClickActionSchema = z.object({
  action: z.enum(["click", "double_click"]),
  revision,
  nodeId,
  button,
}).strict();
const coordinateClickActionSchema = z.object({
  action: z.enum(["click", "double_click"]),
  x: coordinate,
  y: coordinate,
  button,
}).strict();
const typeActionSchema = z.object({
  action: z.literal("type"),
  revision,
  nodeId,
  text: z.string().max(10_000),
  replace: z.boolean().optional(),
}).strict();
const keypressActionSchema = z.object({
  action: z.literal("keypress"),
  keys: z.array(z.string().min(1).max(64)).min(1).max(16),
}).strict();
const nodeScrollActionSchema = z.object({
  action: z.literal("scroll"),
  revision,
  nodeId,
  deltaX: finiteNumber.optional(),
  deltaY: finiteNumber,
}).strict();
const coordinateScrollActionSchema = z.object({
  action: z.literal("scroll"),
  x: coordinate,
  y: coordinate,
  deltaX: finiteNumber.optional(),
  deltaY: finiteNumber,
}).strict();
const moveActionSchema = z.object({
  action: z.literal("move"),
  x: coordinate,
  y: coordinate,
}).strict();
const dragActionSchema = z.object({
  action: z.literal("drag"),
  startX: coordinate,
  startY: coordinate,
  endX: coordinate,
  endY: coordinate,
  durationMs: z.number().int().min(0).max(5_000).optional(),
}).strict();
const waitActionSchema = z.object({
  action: z.literal("wait"),
  durationMs: z.number().int().min(0).max(5_000),
}).strict();
const screenshotActionSchema = z.object({ action: z.literal("screenshot") }).strict();

export const computerActionSchema = z.union([
  observeActionSchema,
  pressActionSchema,
  nodeClickActionSchema,
  coordinateClickActionSchema,
  typeActionSchema,
  keypressActionSchema,
  nodeScrollActionSchema,
  coordinateScrollActionSchema,
  moveActionSchema,
  dragActionSchema,
  waitActionSchema,
  screenshotActionSchema,
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;

export const MUTATING_COMPUTER_ACTIONS = new Set<ComputerAction["action"]>([
  "press",
  "click",
  "double_click",
  "type",
  "keypress",
  "scroll",
  "move",
  "drag",
]);

export function isMutatingComputerAction(action: ComputerAction): boolean {
  return MUTATING_COMPUTER_ACTIONS.has(action.action);
}
