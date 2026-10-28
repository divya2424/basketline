import { act } from '@testing-library/react'

// Controllable IntersectionObserver for jsdom (which has none).
const observers = new Set()
let visible = true

class MockIntersectionObserver {
  constructor(callback) {
    this.callback = callback
    this.elements = new Set()
    observers.add(this)
  }
  observe(element) {
    this.elements.add(element)
    this.callback([entryFor(element)], this)
  }
  unobserve(element) {
    this.elements.delete(element)
  }
  disconnect() {
    this.elements.clear()
    observers.delete(this)
  }
  takeRecords() {
    return []
  }
}

function entryFor(target) {
  return { target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }
}

export function installIntersectionObserver() {
  visible = true
  observers.clear()
  globalThis.IntersectionObserver = MockIntersectionObserver
}

/** Simulates every observed element scrolling into (true) or out of (false) view. */
export function setAllVisible(nextVisible) {
  visible = nextVisible
  act(() => {
    for (const observer of observers) {
      for (const element of observer.elements) observer.callback([entryFor(element)], observer)
    }
  })
}

export function setInitiallyVisible(nextVisible) {
  visible = nextVisible
}
