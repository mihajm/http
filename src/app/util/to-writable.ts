import { Signal, untracked, WritableSignal } from '@angular/core';

export function toWritable<T>(
  signal: Signal<T>,
  set: (value: T) => void,
  update?: (updater: (value: T) => T) => void
): WritableSignal<T> {
  const internal = signal as WritableSignal<T>;
  internal.asReadonly = () => signal;
  internal.set = set;
  internal.update = update ?? ((updater) => set(updater(untracked(internal))));

  return internal;
}
