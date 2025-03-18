

import {
	linkedSignal,
	Signal,
	ValueEqualityFn,
	WritableSignal,
} from '@angular/core';

export function keepPrevious<T>(
	value: WritableSignal<T>,
	loading: Signal<boolean>,
	keep?: boolean,
	equal?: ValueEqualityFn<T>
): WritableSignal<T>;

export function keepPrevious<T>(
	value: Signal<T>,
	loading: Signal<boolean>,
	keep?: boolean,
	equal?: ValueEqualityFn<T>
): Signal<T>;

export function keepPrevious<T>(
	value: WritableSignal<T> | Signal<T>,
	loading: Signal<boolean>,
	keep = false,
	equal?: ValueEqualityFn<T>
): WritableSignal<T> | Signal<T> {
	if (!keep) return value;

	const kept = linkedSignal<
		{
			value: T;
			loading: boolean;
		},
		T
	>({
		source: () => ({
			value: value(),
			loading: loading(),
		}),
		computation: (source, prev) => {
			if (source.loading && prev) return prev.value;

			return source.value;
		},
		equal,
	});

	if ('set' in value) {
		kept.set = value.set;
		kept.update = value.update;
		kept.asReadonly = value.asReadonly;
	}

	return kept;
}

