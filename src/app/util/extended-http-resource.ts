import {
  HttpClient,
  HttpHeaders,
  httpResource,
  HttpResourceOptions,
  HttpResourceRef,
  HttpResourceRequest,
  HttpResponse,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  EffectRef,
  inject,
  isDevMode,
  ResourceStatus,
  Signal,
  untracked,
  WritableSignal,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { injectCache, setCacheContext } from './cache';
import { CircuitBreaker, createCircuitBreaker } from './circuit-breaker';
import { createEqualRequest } from './equal-request';
import { keepPrevious } from './keep-previous';
import { retryOnError, RetryOptions } from './retry-on-error';
import { toWritable } from './to-writable';
import { urlWithParams } from './url-with-params';

export type ExtendedHttpResourceOptions<
  TResult,
  TRaw = TResult
> = HttpResourceOptions<TResult, TRaw> & {
  onError?: (error: unknown) => void;
  keepPrevious?: boolean;
  refresh?: number;
  circuitBreaker?: CircuitBreaker;
  retry?: RetryOptions;
  cache?:
    | true
    | {
        ttl?: number;
        staleTime?: number;
        hash?: (req: HttpResourceRequest) => string;
      };
};

export type ExtendedHttpResourceRef<TResult> = HttpResourceRef<TResult> & {
  disabled: Signal<boolean>;
  prefetch: (req?: Partial<HttpResourceRequest>) => Promise<void>;
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
  const cache = injectCache();
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
      equal: createEqualRequest(options.equal),
    }
  );

  const hashFn =
    typeof options.cache === 'object'
      ? options.cache.hash ?? urlWithParams
      : urlWithParams;

  const staleTime =
    typeof options.cache === 'object' ? options.cache.staleTime : 0;
  const ttl = typeof options.cache === 'object' ? options.cache.ttl : undefined;

  const key = computed(() => {
    const r = req();
    if (!r) return null;
    return hashFn(r);
  });

  const cachedRequest = options.cache
    ? computed(() => {
        const r = req();
        if (!r) return r;

        return {
          ...r,
          context: setCacheContext(r.context, {
            staleTime,
            ttl,
            key: key() ?? hashFn(r),
          }),
        };
      })
    : req;

  const resource = httpResource<TResult>(cachedRequest, {
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: options.parse as any,
  });

  const retryEffect = retryOnError(resource, options.retry);

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

  let statusSub = toObservable(resource.status)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe((status) => {
      switch (status) {
        case ResourceStatus.Resolved: {
          return cb.success();
        }
        case ResourceStatus.Error: {
          return cb.fail();
        }
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

  const set = (value: TResult | undefined) => {
    resource.set(value);
    const k = untracked(key);
    if (options.cache && k)
      cache.storeWithInvalidation(
        k,
        new HttpResponse({
          body: value,
          status: 200,
          statusText: 'OK',
        })
      );
  };

  const update = (
    updater: (value: TResult | undefined) => TResult | undefined
  ) => {
    set(updater(untracked(resource.value)));
  };

  const cachedEvent = toSignal(cache.changes$(toObservable(key)), {
    initialValue: cache.get(untracked(key))?.value ?? null,
  });

  const parse = options.parse ?? ((val: TRaw) => val as unknown as TResult);

  const cachedValue = computed((): TResult | undefined => {
    const ce = cachedEvent();
    if (!ce || !(ce instanceof HttpResponse)) return;
    return parse(ce.body as TRaw);
  });

  const value = options.cache
    ? toWritable(
        computed((): TResult | undefined => {
          return cachedValue() ?? resource.value();
        }),
        resource.value.set,
        resource.value.update
      )
    : resource.value;

  const client = options.injector
    ? options.injector.get(HttpClient)
    : inject(HttpClient);

  return {
    ...resource,
    reload,
    set,
    update,
    destroy: () => {
      refreshSub?.unsubscribe();
      statusSub.unsubscribe();
      onErrorEffect?.destroy();
      retryEffect.destroy();
      resource.destroy();
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
      value as WritableSignal<TResult>,
      computed(() => resource.isLoading() && !cachedValue()),
      options.keepPrevious,
      options.equal
    ),
    disabled: computed(() => cb.isClosed() || req() === undefined),
    prefetch: async (partial) => {
      const request = untracked(req);
      if (!request) return Promise.resolve();

      const prefetchRequest = {
        ...request,
        ...partial,
      };

      try {
        await firstValueFrom(
          client.request<TRaw>(
            prefetchRequest.method ?? 'GET',
            prefetchRequest.url,
            {
              ...prefetchRequest,
              headers: prefetchRequest.headers as HttpHeaders,
              observe: 'response',
            }
          )
        );

        return;
      } catch (err) {
        if (isDevMode()) console.error('Prefetch failed: ', err);
        return;
      }
    },
  };
}
