import type { ComponentType } from "react";
import { StoryboardWorkbench } from "./StoryboardWorkbench.js";

export const widgetRegistry: Record<string, ComponentType<any>> = {
  storyboard_workbench: StoryboardWorkbench,
};
