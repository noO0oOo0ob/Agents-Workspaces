import { EventEmitter } from "node:events";
import type { DomainEvent } from "@agents-workspaces/core";

export class LocalEventBus {
  readonly #emitter = new EventEmitter();

  publish(event: DomainEvent): void {
    this.#emitter.emit("event", event);
  }

  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}

