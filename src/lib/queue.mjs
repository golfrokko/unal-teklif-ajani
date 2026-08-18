export class JobQueue {
  #pending = [];
  #active = new Map();
  #scheduled = false;

  constructor({ maxActive = 1, handler, onError }) {
    this.maxActive = maxActive;
    this.handler = handler;
    this.onError = onError;
  }

  get stats() {
    return { queued: this.#pending.length, active: this.#active.size, maxActive: this.maxActive };
  }

  add(jobId) {
    if (this.#pending.includes(jobId) || this.#active.has(jobId)) return false;
    this.#pending.push(jobId);
    this.#schedule();
    return true;
  }

  cancelPending(jobId) {
    const index = this.#pending.indexOf(jobId);
    if (index < 0) return false;
    this.#pending.splice(index, 1);
    return true;
  }

  isActive(jobId) {
    return this.#active.has(jobId);
  }

  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }

  #drain() {
    while (this.#active.size < this.maxActive && this.#pending.length) {
      const jobId = this.#pending.shift();
      const execution = Promise.resolve()
        .then(() => this.handler(jobId))
        .catch((error) => this.onError?.(jobId, error))
        .finally(() => {
          this.#active.delete(jobId);
          this.#schedule();
        });
      this.#active.set(jobId, execution);
    }
  }
}
