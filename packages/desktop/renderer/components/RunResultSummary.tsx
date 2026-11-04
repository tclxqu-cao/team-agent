import React from "react";
import type { RunResult } from "@agent/core";
import { Check, CircleAlert, Square } from "lucide-react";
import { formatRunResultSummary } from "../lib/run-result";

export default function RunResultSummary({ result }: { result: RunResult }) {
  const Icon = result.status === "completed" && result.reason === "completed"
    ? Check : result.status === "cancelled" ? Square : CircleAlert;
  return (
    <span className={`msg-completion-status msg-run-result msg-run-result--${result.status}${result.status === "completed" && result.reason !== "completed" ? " msg-run-result--limited" : ""}`} role="status">
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      <span>{formatRunResultSummary(result)}</span>
    </span>
  );
}
