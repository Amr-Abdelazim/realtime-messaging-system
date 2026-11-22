export class InFlightOperations {
  private accepting = true
  private active = 0
  private readonly idleWaiters = new Set<() => void>()

  begin(): (() => void) | undefined {
    if (!this.accepting) {
      return undefined
    }

    return this.start()
  }

  beginCleanup(): () => void {
    return this.start()
  }

  stopAccepting(): void {
    this.accepting = false
  }

  waitForIdle(): Promise<void> {
    if (this.active === 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private start(): () => void {
    this.active += 1
    let completed = false

    return () => {
      if (completed) {
        return
      }
      completed = true
      this.active -= 1

      if (this.active === 0) {
        for (const resolve of this.idleWaiters) {
          resolve()
        }
        this.idleWaiters.clear()
      }
    }
  }
}
