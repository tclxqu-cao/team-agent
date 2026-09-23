export type ChatAutoScrollMode = "instant" | "skip" | null;

export interface ChatAutoFollowController {
  onScroll(distanceFromBottom: number): boolean;
  requestReturn(): void;
  reset(): void;
  shouldFollow(mode: ChatAutoScrollMode): boolean;
  isFollowing(): boolean;
}

/** Keeps streaming output pinned only while the reader remains near the bottom. */
export function createChatAutoFollowController(thresholdPx: number): ChatAutoFollowController {
  let following = true;
  let returning = false;

  return {
    onScroll(distanceFromBottom) {
      const awayFromBottom = distanceFromBottom > thresholdPx;
      if (!awayFromBottom) {
        following = true;
        returning = false;
      } else if (!returning) {
        following = false;
      }
      return awayFromBottom;
    },
    requestReturn() {
      following = true;
      returning = true;
    },
    reset() {
      following = true;
      returning = false;
    },
    shouldFollow(mode) {
      if (mode === "skip") return false;
      if (mode === "instant") {
        following = true;
        returning = false;
      }
      return following;
    },
    isFollowing() {
      return following;
    },
  };
}
