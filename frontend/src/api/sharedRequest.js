const pendingByOwner = new WeakMap()

/**
 * Runs `load()` once per (owner, key) while it is pending; callers asking for
 * the same thing in the meantime share its promise. Components ignore results
 * they no longer need instead of aborting, so React StrictMode's dev re-mount
 * reuses the first request rather than cancelling it and sending another.
 */
export function sharedRequest(owner, key, load) {
  let pending = pendingByOwner.get(owner)
  if (!pending) pendingByOwner.set(owner, (pending = new Map()))
  let promise = pending.get(key)
  if (!promise) {
    promise = load().finally(() => pending.delete(key))
    pending.set(key, promise)
  }
  return promise
}
