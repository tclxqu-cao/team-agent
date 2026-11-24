import { CalendarDays } from "lucide-react";

interface DesktopAppActionsProps {
  onOpenCalendar: () => void;
}

export default function DesktopAppActions({ onOpenCalendar }: DesktopAppActionsProps) {
  return (
    <div className="desktop-app-actions" role="toolbar" aria-label="应用快捷操作">
      <button
        type="button"
        className="ui-icon-button desktop-app-action desktop-app-action--calendar"
        onClick={onOpenCalendar}
        title="智能体日历"
        aria-label="打开日历"
      >
        <CalendarDays size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
