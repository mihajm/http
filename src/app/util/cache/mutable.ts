import {
  signal,
  type CreateSignalOptions,
  type ValueEqualityFn,
  type WritableSignal,
} from '@angular/core';

const { is } = Object;

export type MutableSignal<T> = WritableSignal<T> & {
  mutate: WritableSignal<T>['update'];
};

export function mutable<T>(): MutableSignal<T | undefined>;
export function mutable<T>(initial: T): MutableSignal<T>;
export function mutable<T>(
  initial: T,
  opt?: CreateSignalOptions<T>
): MutableSignal<T>;

export function mutable<T>(
  initial?: T,
  opt?: CreateSignalOptions<T>
): MutableSignal<T | undefined> {
  const baseEqual = opt?.equal ?? is;
  let trigger = false;

  const equal: ValueEqualityFn<T | undefined> = (a, b) => {
    if (trigger) return false;
    if (!a && !b) return true;
    if (!a || !b) return false;
    return baseEqual(a, b);
  };

  const sig = signal<T | undefined>(initial, {
    ...opt,
    equal,
  }) as MutableSignal<T>;
  const internalUpdate = sig.update;

  sig.mutate = (updater) => {
    trigger = true;
    internalUpdate(updater);
    trigger = false;
  };

  return sig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isMutable<T = any>(
  value: WritableSignal<T>
): value is MutableSignal<T> {
  return 'mutate' in value && typeof value.mutate === 'function';
}
