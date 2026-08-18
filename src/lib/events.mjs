import { EventEmitter } from "node:events";

export class JobEvents {
  #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(200);
  }

  publish(jobId, type, payload = {}) {
    this.#emitter.emit(jobId, { type, at: new Date().toISOString(), ...payload });
  }

  subscribe(jobId, listener) {
    this.#emitter.on(jobId, listener);
    return () => this.#emitter.off(jobId, listener);
  }
}
