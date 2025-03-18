import {
  HttpClient,
  HttpHeaders,
  httpResource,
  HttpResponse,
  type HttpResourceOptions,
  type HttpResourceRef,
  type HttpResourceRequest,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  effect,
  inject,
  isDevMode,
  ResourceStatus,
  Signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { injectCache, setCacheContext } from './cache';
import { CircuitBreakerOptions, createCircuitBreaker } from './circuit-breaker';
import { createEqualRequest } from './equal-request';
import { hasSlowConnection } from './has-slow-connection';
import { persistResourceValues } from './persist-values';
import { refresh } from './refresh';
import { retryOnError, type RetryOptions } from './retry-on-error';
import { toWritable } from './to-writable';
import { urlWithParams } from './url-with-params';

type ResourceCacheOptions =
  | true
  | {
      ttl?: number;
      staleTime?: number;
      hash?: (req: HttpResourceRequest) => string;
    };

export type ExtendResourceOptions<
  TResult,
  TRaw = TResult
> = HttpResourceOptions<TResult, TRaw> & {
  keepPrevious?: boolean; // Keep the previous value when refreshing
  refresh?: number; // Refresh the value every n milliseconds
  retry?: RetryOptions; // Retry on error options
  onError?: (err: unknown) => void; // Error handler, useful for say displaying a toast
  circuitBreaker?: CircuitBreakerOptions;
  cache?: ResourceCacheOptions;
};

export type ExtendedResourceRef<TResult> = HttpResourceRef<TResult> & {
  disabled: Signal<boolean>;
  prefetch: (req?: Partial<HttpResourceRequest>) => Promise<void>;
};

export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  }
): ExtendedResourceRef<TResult>;

export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendResourceOptions<TResult, TRaw>
): ExtendedResourceRef<TResult | undefined>;

export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendResourceOptions<TResult, TRaw>
): ExtendedResourceRef<TResult | undefined> {
  const cache = injectCache(options?.injector);

  const destroyRef = options?.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const cb = createCircuitBreaker(options?.circuitBreaker);

  const stableRequest = computed(
    () => {
      if (cb.isClosed()) return undefined;
      return request();
    },
    {
      equal: createEqualRequest(options?.equal),
    }
  );

  const hashFn =
    typeof options?.cache === 'object'
      ? options.cache.hash ?? urlWithParams
      : urlWithParams;

  const staleTime =
    typeof options?.cache === 'object' ? options.cache.staleTime : 0;
  const ttl =
    typeof options?.cache === 'object' ? options.cache.ttl : undefined;

  const cacheKey = computed(() => {
    const r = stableRequest();
    if (!r) return null;
    return hashFn(r);
  });

  const cachedRequest = options?.cache
    ? computed(() => {
        const r = stableRequest();
        if (!r) return r;

        return {
          ...r,
          context: setCacheContext(r.context, {
            staleTime,
            ttl,
            key: cacheKey() ?? hashFn(r),
          }),
        };
      })
    : stableRequest;

  let resource = httpResource<TResult>(cachedRequest, {
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: options?.parse as any, // Not my favorite thing to do, but here it is completely safe.
  }) as HttpResourceRef<TResult>;

  // get full HttpResonse from Cache
  const cachedEvent = cache.get(cacheKey);

  const parse = options?.parse ?? ((val: TRaw) => val as unknown as TResult);

  const cachedValue = computed((): TResult | undefined => {
    const ce = cachedEvent();
    if (!ce || !(ce instanceof HttpResponse)) return;
    return parse(ce.body as TRaw);
  });

  const value = options?.cache
    ? toWritable(
        computed((): TResult => {
          return cachedValue() ?? resource.value();
        }),
        resource.value.set,
        resource.value.update
      )
    : resource.value;

  resource = refresh(resource, destroyRef, options?.refresh);
  resource = retryOnError(resource, options?.retry);
  resource = persistResourceValues<TResult>(
    { ...resource, value },
    computed(() => !!cachedValue()),
    options?.keepPrevious,
    options?.equal
  );

  const onError = options?.onError; // Put in own variable to ensure value remains even if options are somehow mutated in-line
  if (onError) {
    const onErrorRef = effect(() => {
      const err = resource.error();
      if (err) onError(err);
    });

    // cleanup on manual destroy, I'm comfortable setting these props in-line as we have yet to 'release' the object out of this lexical scope
    const destroyRest = resource.destroy;
    resource.destroy = () => {
      onErrorRef.destroy();
      destroyRest();
    };
  }

  // iterate circuit breaker state, is effect as a computed would cause a circular dependency (resource -> cb -> resource)
  const cbEffectRef = effect(() => {
    const status = resource.status();
    if (status === ResourceStatus.Error) cb.fail();
    else if (status === ResourceStatus.Resolved) cb.success();
  });

  const set = (value: TResult) => {
    resource.set(value);
    const k = untracked(cacheKey);
    if (options?.cache && k)
      cache.store(
        k,
        new HttpResponse({
          body: value,
          status: 200,
          statusText: 'OK',
        })
      );
  };

  const update = (updater: (value: TResult) => TResult) => {
    set(updater(untracked(resource.value)));
  };

  const client = options?.injector
    ? options.injector.get(HttpClient)
    : inject(HttpClient);

  return {
    ...resource,
    value,
    set,
    update,
    disabled: computed(() => cb.isClosed() || stableRequest() === undefined),
    reload: () => {
      cb.halfOpen(); // open the circuit for manual reload
      return resource.reload();
    },
    destroy: () => {
      cbEffectRef.destroy();
      cb.destroy();
      resource.destroy();
    },
    prefetch: async (partial) => {
      if (!options?.cache || hasSlowConnection()) return Promise.resolve();

      const request = untracked(cachedRequest);
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
