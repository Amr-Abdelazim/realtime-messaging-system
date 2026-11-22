export class TypedEventEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: unknown) => void>>()

  on<Event extends keyof Events>(
    event: Event,
    listener: (payload: Events[Event]) => void,
  ): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }

    const handler = (payload: unknown): void => listener(payload as Events[Event])
    listeners.add(handler)
    return () => {
      listeners?.delete(handler)
      if (listeners?.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  emit<Event extends keyof Events>(event: Event, payload: Events[Event]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }
}
