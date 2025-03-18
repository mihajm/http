import {
  HttpHeaders,
  httpResource,
  HttpResourceOptions,
  HttpResourceRef,
  HttpResourceRequest,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  EffectRef,
  inject,
  ResourceStatus,
  Signal,
  WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { interval, Subscription } from 'rxjs';
import { CircuitBreaker, createCircuitBreaker } from './circuit-breaker';
import { equalRequest } from './equal-request';
import { keepPrevious } from './keep-previous';

export type ExtendedHttpResourceOptions<
  TResult,
  TRaw = TResult
> = HttpResourceOptions<TResult, TRaw> & {
  onError?: (error: unknown) => void;
  keepPrevious?: boolean;
  refresh?: number;
  circuitBreaker?: CircuitBreaker;
};

export type ExtendedHttpResourceRef<TResult> = HttpResourceRef<TResult> & {
  disabled: Signal<boolean>;
};

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendedHttpResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  }
): ExtendedHttpResourceRef<TResult>;

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendedHttpResourceOptions<TResult, TRaw>
): ExtendedHttpResourceRef<TResult | undefined>;

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendedHttpResourceOptions<TResult, TRaw>
): ExtendedHttpResourceRef<TResult | undefined> {
  const cb = options.circuitBreaker ?? createCircuitBreaker();
  const destroyRef = options.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const req = computed(
    () => {
      if (cb.isClosed()) return undefined;

      return request();
    },
    {
      equal: equalRequest,
    }
  );

  const resource = httpResource<TResult>(req, {
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: options.parse as any,
  });

  let statusSub = toObservable(resource.status)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe((status) => {
      switch (status) {
        case ResourceStatus.Resolved:
          return cb.success();
        case ResourceStatus.Error:
          return cb.fail();
      }
    });

  let refreshSub: Subscription | null = null;
  if (options.refresh) {
    refreshSub = interval(options.refresh)
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => resource.reload());
  }

  let onErrorEffect: EffectRef | null = null;
  const onError = options.onError;
  if (onError) {
    onErrorEffect = effect(() => {
      const err = resource.error();
      if (!err) return;
      onError(err);
    });
  }

  const reload = (): boolean => {
    refreshSub?.unsubscribe();
    refreshSub = null;
    cb.halfOpen();

    const hasReloaded = resource.reload();

    if (options.refresh) {
      refreshSub = interval(options.refresh)
        .pipe(takeUntilDestroyed(destroyRef))
        .subscribe(() => resource.reload());
    }

    return hasReloaded;
  };

  return {
    ...resource,
    reload,
    destroy: () => {
      refreshSub?.unsubscribe();
      statusSub.unsubscribe();
      resource.destroy();
      onErrorEffect?.destroy();
    },
    statusCode: keepPrevious<number | undefined>(
      resource.statusCode,
      resource.isLoading,
      options.keepPrevious
    ),
    headers: keepPrevious<HttpHeaders | undefined>(
      resource.headers,
      resource.isLoading,
      options.keepPrevious
    ),
    value: keepPrevious<TResult>(
      resource.value as WritableSignal<TResult>,
      resource.isLoading,
      options.keepPrevious,
      options.equal
    ),
    disabled: computed(() => cb.isClosed() || req() === undefined),
  };
}
