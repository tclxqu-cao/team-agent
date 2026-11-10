import { isDirectHoverInput } from '../../../core/src/domain/live-view/remote-direct-input.js';

type Input = Record<string, unknown>;
type Reply = Record<string, unknown> | null;
type Fallback = (input: Input) => Promise<Reply>;
interface Operation {
  index: number; sequence: number; input: Input; fallback: Fallback;
  resolve(value: Reply): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; fallingBack?: boolean;
}
const canceled = () => Object.assign(new Error('输入会话已切换'), { code: 'ECANCELED' });

/** Negotiated input transport. Both reliable ports share one operation identity. */
export class BrowserRemoteDirectInput {
  private channel?: RTCDataChannel;
  private reliable?: RTCDataChannel;
  private sequence = 0;
  private barrier = 0;
  private index = 0;
  private pressed = false;
  private stopped = false;
  private visible = true;
  private remove?: () => void;
  private checkpoint?: ReturnType<typeof setTimeout>;
  private pending = new Map<number, Operation>();
  private queue: Operation[] = [];
  constructor(private readonly stream?: string, private readonly version = 1,
    private readonly onError: (error: Error) => void = () => {}) {}
  attach(peer: RTCPeerConnection): void {
    if (!this.stream || this.stream.length < 16 || this.stream.length > 64) return;
    const accept = (event: RTCDataChannelEvent) => {
      const channel = event.channel;
      if (this.stopped) return;
      if (channel.label === 'agentroam.input.v1') {
        if (this.channel) { channel.close(); return; }
        this.channel = channel;
        channel.onclose = () => { if (this.channel === channel) this.channel = undefined; };
      } else if (channel.label === 'agentroam.input.reliable.v1' && this.version === 2) {
        if (this.reliable) { channel.close(); return; }
        this.reliable = channel;
        channel.onmessage = event => this.receipt(event.data);
        channel.onclose = () => {
          if (this.reliable === channel) this.reliable = undefined;
          if (!this.stopped) for (const operation of this.pending.values()) this.fallback(operation);
        };
      }
    };
    peer.addEventListener('datachannel', accept);
    this.remove = () => peer.removeEventListener('datachannel', accept);
  }
  prepare(input: Input): { fast: boolean; input: Input } {
    this.cancelCheckpoint();
    if (this.stopped || !this.stream) return { fast: false, input };
    const sequence = ++this.sequence;
    const hover = isDirectHoverInput(input, this.pressed);
    if (hover && this.visible && this.channel?.readyState === 'open' && this.channel.bufferedAmount < 16_000) {
      try {
        this.channel.send(JSON.stringify({ kind: 'move', stream: this.stream, sequence, barrier: this.barrier,
          x: input.x, y: input.y, mobile: input.mobile === true }));
        return { fast: true, input };
      } catch { /* Fall through to the reliable request port. */ }
    }
    this.noteReliable(input, sequence);
    return { fast: false, input: { ...input, direct: { stream: this.stream, sequence } } };
  }
  dispatch(input: Input, fallback: Fallback): Promise<Reply> {
    if (this.stopped) return Promise.reject(canceled());
    if (this.version !== 2 || !this.stream) {
      const delivery = this.prepare(input);
      if (!delivery.fast) return fallback(delivery.input);
      this.scheduleCheckpoint(input, fallback); return Promise.resolve(null);
    }
    this.cancelCheckpoint();
    if (isDirectHoverInput(input, this.pressed) && this.visible && this.channel?.readyState === 'open' && this.channel.bufferedAmount < 16_000) {
      const sequence = ++this.sequence;
      try {
        this.channel.send(JSON.stringify({ kind: 'move', stream: this.stream, sequence, barrier: this.barrier,
          x: input.x, y: input.y, mobile: input.mobile === true }));
        this.scheduleCheckpoint(input, fallback); return Promise.resolve(null);
      } catch { /* Reconcile all actions on the same reliable ledger. */ }
    }
    return this.enqueue(input, fallback);
  }
  private enqueue(input: Input, fallback: Fallback): Promise<Reply> {
    if (this.stopped) return Promise.reject(canceled());
    if (this.pending.size >= 16 && this.queue.length >= 64)
      return Promise.reject(Object.assign(new Error('输入队列繁忙，请稍后重试'), { code: 'EBUSY' }));
    const sequence = ++this.sequence, index = ++this.index;
    this.noteReliable(input, sequence);
    return new Promise((resolve, reject) => {
      this.queue.push({ index, sequence, input: { ...input, direct: { stream: this.stream, sequence, index } }, fallback, resolve, reject });
      this.pump();
    });
  }
  private pump(): void {
    while (!this.stopped && this.pending.size < 16 && this.queue.length) {
      const operation = this.queue.shift()!;
      this.pending.set(operation.index, operation);
      const data = JSON.stringify({ kind: 'request', stream: this.stream, index: operation.index, sequence: operation.sequence, input: operation.input });
      if (this.reliable?.readyState === 'open' && new TextEncoder().encode(data).length <= 12_288 && this.reliable.bufferedAmount < 64_000) {
        try {
          operation.timer = setTimeout(() => this.fallback(operation), 750);
          this.reliable.send(data); continue;
        } catch { /* Retry the same stamped operation through the request port. */ }
      }
      this.fallback(operation);
    }
  }
  private fallback(operation: Operation): void {
    if (this.stopped || operation.fallingBack || this.pending.get(operation.index) !== operation) return;
    operation.fallingBack = true; clearTimeout(operation.timer);
    Promise.resolve().then(() => operation.fallback(operation.input)).then(
      result => this.settle(operation, result), error => this.settle(operation, null, error instanceof Error ? error : new Error(String(error))));
  }
  private receipt(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > 32_768) return;
    try {
      const message = JSON.parse(raw), operation = this.pending.get(message.index);
      if (!operation || message.kind !== 'result' || message.stream !== this.stream || message.sequence !== operation.sequence) return;
      if (message.ok === true) this.settle(operation, { input: message.result });
      else if (message.ok === false) this.settle(operation, null, Object.assign(new Error(String(message.error || '输入失败')), { code: message.code }));
    } catch { /* A missing/invalid receipt is reconciled by the request port. */ }
  }
  private settle(operation: Operation, result: Reply, error?: Error): void {
    if (this.pending.get(operation.index) !== operation) return;
    clearTimeout(operation.timer); this.pending.delete(operation.index);
    if (error) { operation.reject(error); this.stop(); }
    else { operation.resolve(result); this.pump(); }
  }
  private noteReliable(input: Input, sequence: number): void {
    if (input.kind === 'pointer' && input.action === 'down') this.pressed = true;
    if (input.kind === 'pointer' && input.action === 'up') this.pressed = false;
    this.barrier = sequence;
  }
  private scheduleCheckpoint(input: Input, fallback: Fallback): void {
    this.checkpoint = setTimeout(() => {
      this.checkpoint = undefined;
      if (this.stopped || !this.visible || this.pressed) return;
      const sequence = this.version === 2 ? 0 : ++this.sequence;
      if (this.version !== 2) this.noteReliable(input, sequence);
      const result = this.version === 2 ? this.enqueue(input, fallback) : fallback({ ...input, direct: { stream: this.stream, sequence } });
      result.then(reply => {
        const failure = (reply?.input as { error?: string } | undefined)?.error;
        if (failure) this.onError(new Error(failure));
      }).catch(error => { if (error?.code !== 'ECANCELED') this.onError(error); });
    }, 40);
  }
  private cancelCheckpoint(): void { clearTimeout(this.checkpoint); this.checkpoint = undefined; }
  setVisible(visible: boolean): void { this.visible = visible; if (!visible) this.cancelCheckpoint(); }
  stop(): void {
    this.stopped = true; this.cancelCheckpoint(); this.remove?.();
    for (const operation of [...this.pending.values(), ...this.queue]) { clearTimeout(operation.timer); operation.reject(canceled()); }
    this.pending.clear(); this.queue = [];
    this.channel?.close(); this.channel = undefined; this.reliable?.close(); this.reliable = undefined;
  }
}
