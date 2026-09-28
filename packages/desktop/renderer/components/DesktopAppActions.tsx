import { Bot, LoaderCircle } from "lucide-react";

interface DesktopAppActionsProps {
  onOpenFlowStudio: () => void;
  openingFlowStudio?: boolean;
}

export default function DesktopAppActions({
  onOpenFlowStudio,
  openingFlowStudio = false,
}: DesktopAppActionsProps) {
  return (
    <div className="desktop-app-actions" role="toolbar" aria-label="应用快捷操作">
      <button
        type="button"
        className="ui-icon-button desktop-app-action desktop-app-action--flow-studio"
        onClick={onOpenFlowStudio}
        disabled={openingFlowStudio}
        title="数字人 · Flow Studio"
        aria-label="打开 Flow Studio"
        aria-busy={openingFlowStudio}
      >
        {openingFlowStudio
          ? <LoaderCircle className="desktop-app-action-spinner" size={17} aria-hidden="true" />
          : <Bot size={17} aria-hidden="true" />}
      </button>
    </div>
  );
}
