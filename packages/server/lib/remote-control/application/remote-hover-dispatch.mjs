import { RemoteHoverDispatchPolicy } from '@agent/core';

/** Retains the last admitted hover while enforcing native dispatch spacing. */
export class RemoteHoverDispatch {
  constructor({ clock, write }) {
    this.clock = clock; this.write = write; this.policy = new RemoteHoverDispatchPolicy();
  }
  offer(message) {
    const delay = this.policy.offer(message.sequence, this.clock.now());
    if (delay === null) return;
    this.pending = message;
    if (this.timer !== undefined) return;
    if (delay === 0) this.flush();
    else this.timer = this.clock.schedule(() => { this.timer = undefined; this.flush(); }, delay);
  }
  flush() {
    const message = this.pending; this.pending = undefined;
    if (!message) return;
    this.policy.dispatched(this.clock.now()); this.write(message);
  }
  cancel() {
    if (this.timer !== undefined) this.clock.cancel(this.timer);
    this.timer = undefined; this.pending = undefined;
  }
  stop() { this.cancel(); this.policy.reset(); }
}
