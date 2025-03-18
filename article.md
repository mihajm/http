# Fun-grained Reactivity in Angular: Part 3 - Client-Side HTTP

In the previous installments of this series, we explored building foundational signal-based primitives such (`mutable`, `store`, `derived`) and applied them to create reactive form controls. This time, we turn our attention to another critical aspect of modern web applications: _client-side_ management of asynchronous data. Don't worry though we'll get to _server-side_ soon enough! ;)

## Why...just why?

Angular has long offered quite a robust suite of tools to manage HTTP communication/asyn state. Built in tools such as `HttpClient` the `AsyncPipe`, interceptors etc. have allowed us to build very advanced & robust features throughout the years, but it seems times are shifting. Angular is evolving/extending/replacing these primitives with some signal based alternatives such as `httpResource`, which allow us to better hook in to our _new 'fine-grained' state_, and honestly it's about time! RxJs Observables have long been something that most people need time to wrap their heads around & recently `HttpClient` has been the source of most (if not all) `Observables` in _high-level_ parts of our codebase. Likewise the typical pattern of having a Service class whose function returns an `Observable`, which completes when the request finishes/errors, has always been slightly off to me...it makes sense for socket like subscriptions, but not for one-and-done requests. It's why I, personally, welcome all the new signal based primitives, such as `httpResource`, hopefuly they make our livers much easier & our codebases more sane.

There are however...one or two more things to think about with our new reality as of Angular 19.2...`httpResource` isn't _really_ meant for mutating server side data through say PATCH requests, you can do it, but what signal should you react to & how do you begin to _set things up_. Likewise there is a bit of additional logic we tend to need in our modern client side applications, such as retry-ing on error, caching, request deduplication & more, it's one of the many reasons I and (I assume) a lot of you have reached for libraries such as [tanstack query's new Angular adapter](https://tanstack.com/query/v5/docs/framework/angular/overview). In fact in v18 we replaced quite a decent chunk of our own http logic with tanstack query & we're very _mostly_ loved the results :) so if you're looking for a _battle tested_ library to handle these things for you, I'd say look no further...add the library & get back to coding feature's you're clients will love.

If, however, you want to join me on another deep dive, to build, understand, and control...keep reading! :)

## Goals

Before we begin let's outline our feature goals, so that we can understand what we want to accomplish today & if we've actually done so. Here's my list, I hope it satisfies yours as well:

1. Utilize built-in Angular primitives such as `httpResource` under the hood, ensuring (as much as possible) we remain in-sync with the current vision of the Angular team.
2. Use signal-based primitives & computeds on the state itself, ensuring the _reactive graph_ is maintained.
3. Keep the core interface similar to built-in primitives such as `httpResource`.
4. Provide a simple `onError` callback for handling errors and displaying notifications (e.g., using Angular Material's snackbar).
5. Add persistence to data between refreshes; `httpResource` and other such primitives set their values to `undefined` when refreshing.
6. Make refreshing on intervals and retrying on errors easy.
7. Add circuit breaker options so that APIs under a lot of pressure aren't overloaded.
8. Add cache and prefetch options, similar in behavior to TanStack Query (staleTime + ttl (time-to-live)). Stale data should be shown but immediately refreshed. Multiple resources connected to the same cache entry should reflect updates to that entry.
9. Allow for flexible mutations, with built-in support for optimistic updates.
10. Deduplicate requests that are in-flight to ensure more consistent behavior. - optional

Keep in mind that the async part of signals is currently changing very quickly, with Angular sure to add new resource primitive & SolidJs exploring brand new ideas like [createAsync](https://dev.to/this-is-learning/async-derivations-in-reactivity-ec5), it's definitely an interesting time to be in the JS ecosystem. We'll keep an eye out on all of them & come up with new additions together.

Alrighty, I think that should be _more than enough_ for modern applications...Let's get started building our new primitives 1 step at a time, adding each feature to them as we go.

## The "easy" stuff

Let's get a few quick and easy things out of the way, namely defining the base interface/types & adding retry, refetch, onError & value persistance. I've opted to define the interface of many if not all helper functions to take in the resource & return a new object with modified props so that we can more easily _reason_ about what each helper is doing. Feel free to refactor the code if you prefer it all to live in one function. I've also split it up into multiple files/code snippets to again improve readability as much as possible.

```typescript
// refresh.ts
import { HttpResourceRef } from "@angular/common/http";
import { DestroyRef } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { interval } from "rxjs";

// refresh resource every n miliseconds or don't refresh if undefined provided. 0 also excluded, due to it not being a valid usecase
export function refresh<T>(resource: HttpResourceRef<T>, destroyRef: DestroyRef, refresh?: number): HttpResourceRef<T> {
  if (!refresh) return resource; // no refresh requested

  // we can use RxJs here as reloading the resource will always be a side effect & as such does not impact the reactive graph in any way.
  let sub = interval(refresh)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => resource.reload());

  let reload = (): boolean => {
    sub.unsubscribe(); // do not conflict with manual reload

    const hasReloaded = resource.reload();

    // resubscribe after manual reload
    sub = interval(refresh)
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe(() => resource.reload());

    return hasReloaded;
  };

  return {
    ...resource,
    reload,
    destroy: () => {
      sub.unsubscribe();
      resource.destroy();
    },
  };
}
```

```typescript
// retry-on-error.ts
import { type HttpResourceRef } from "@angular/common/http";
import { effect, ResourceStatus } from "@angular/core";

export type RetryOptions =
  | number
  | {
      max?: number;
      backoff?: number;
    };

// Retry on error, if number is provided it will retry that many times with exponential backoff, otherwise it will use the options provided
export function retryOnError<T>(res: HttpResourceRef<T>, opt?: RetryOptions): HttpResourceRef<T> {
  const max = opt ? (typeof opt === "number" ? opt : opt.max ?? 0) : 0;
  const backoff = typeof opt === "object" ? opt.backoff ?? 1000 : 1000;

  let retries = 0;

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const onError = () => {
    if (retries >= max) return;
    retries++;

    if (timeout) clearTimeout(timeout);

    setTimeout(() => res.reload(), retries <= 0 ? 0 : backoff * Math.pow(2, retries - 1));
  };

  const onSuccess = () => {
    if (timeout) clearTimeout(timeout);
    retries = 0;
  };

  // same as refresh this can again be a simple side effect
  const ref = effect(() => {
    switch (res.status()) {
      case ResourceStatus.Error:
        return onError();
      case ResourceStatus.Resolved:
        return onSuccess();
    }
  });

  return {
    ...res,
    destroy: () => {
      ref.destroy(); // cleanup on manual destroy
      res.destroy();
    },
  };
}
```

```typescript
// persist-values.ts
import { type HttpHeaders, type HttpResourceRef } from "@angular/common/http";
import { linkedSignal, type Signal, type ValueEqualityFn, type WritableSignal } from "@angular/core";

function presist<T>(value: WritableSignal<T>, usePrevious: Signal<boolean>, equal?: ValueEqualityFn<T>): WritableSignal<T>;

function presist<T>(value: Signal<T>, usePrevious: Signal<boolean>, equal?: ValueEqualityFn<T>): Signal<T>;

function presist<T>(value: WritableSignal<T> | Signal<T>, usePrevious: Signal<boolean>, equal?: ValueEqualityFn<T>): WritableSignal<T> | Signal<T> {
  // linkedSignal allows us to access previous source value
  const persisted = linkedSignal<
    {
      value: T;
      usePrevious: boolean;
    },
    T
  >({
    source: () => ({
      value: value(),
      usePrevious: usePrevious(),
    }),
    computation: (source, prev) => {
      if (source.usePrevious && prev) return prev.value;

      return source.value;
    },
    equal,
  });

  // if original value was WritableSignal then override linkedSignal methods to original...angular uses linkedSignal under the hood in ResourceImpl, this applies to that.
  if ("set" in value) {
    persisted.set = value.set;
    persisted.update = value.update;
    persisted.asReadonly = value.asReadonly;
  }

  return persisted;
}

export function persistResourceValues<T>(resource: HttpResourceRef<T>, persist = false, equal?: ValueEqualityFn<T>): HttpResourceRef<T> {
  if (!persist) return resource;

  return {
    ...resource,
    statusCode: presist<number | undefined>(resource.statusCode, resource.isLoading),
    headers: presist<HttpHeaders | undefined>(resource.headers, resource.isLoading),
    value: presist<T>(resource.value, resource.isLoading, equal),
  };
}
```

```typescript
// extended-resource.ts
import { httpResource, type HttpResourceOptions, type HttpResourceRef, type HttpResourceRequest } from "@angular/common/http";
import { computed, DestroyRef, effect, inject } from "@angular/core";
import { createEqualRequest } from "./equal-request";
import { persistResourceValues } from "./persist-values";
import { refresh } from "./refresh";
import { retryOnError, type RetryOptions } from "./retry-on-error";

export type ExtendResourceOptions<TResult, TRaw = TResult> = HttpResourceOptions<TResult, TRaw> & {
  keepPrevious?: boolean; // Keep the previous value when refreshing
  refresh?: number; // Refresh the value every n milliseconds
  retry?: RetryOptions; // Retry on error options
  onError?: (err: unknown) => void; // Error handler, useful for say displaying a toast
};

export type ExtendedResourceRef<TResult> = HttpResourceRef<TResult>;

export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  }
): ExtendedResourceRef<TResult>;

export function extendedResource<TResult, TRaw = TResult>(request: () => HttpResourceRequest | undefined, options?: ExtendResourceOptions<TResult, TRaw>): ExtendedResourceRef<TResult | undefined>;

export function extendedResource<TResult, TRaw = TResult>(request: () => HttpResourceRequest | undefined, options?: ExtendResourceOptions<TResult, TRaw>): ExtendedResourceRef<TResult | undefined> {
  const stableRequest = computed(() => request(), {
    equal: createEqualRequest(options?.equal),
  });

  const destroyRef = options?.injector ? options.injector.get(DestroyRef) : inject(DestroyRef);

  let resource = httpResource<TResult>(stableRequest, {
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: options?.parse as any, // Not my favorite thing to do, but here it is completely safe.
  }) as HttpResourceRef<TResult>; // type case due to TS infering that it could also be TResult | undefined. This inference is not correct as function overloading prevents it.

  resource = refresh(resource, destroyRef, options?.refresh);
  resource = retryOnError(resource, options?.retry);
  resource = persistResourceValues<TResult>(resource, options?.keepPrevious, options?.equal);

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

  return resource;
}
```

So there we have it, our _beta_ version of the extendedResource :) I hope the code & comments make it all self explanatory.

One thing I'd like to expand on is that I've consciously restricted the main interface so that it only accepts a request function instead of the many variations `httpResource` provides such as a simple string. This is because I believe all this additional logic is not really necessary if you have an _immutable_ piece of state, fetched at say the top level of your application & even if you wanted some particular feature such as refresh/retry for that, you could simply just pass that into this signature & it would work perfectly. Likewise we don't really require .blob/.text in our apps, if you do it would be simple enough to add this functionality or create a separate resource extension for that following the same patterns/code. The point I'm trying to make, in a very roundabout way, is...let's keep it simple.

## The circuit breaker

This one also isn't _hard_ to do, since we're using a single threaded language. We're going to build a very basic circuit breaker with the _basic_ three states: 'CLOSED', 'OPEN' & 'HALF_OPEN'. If an api responds with an error n times, we will close the circuit & open it half-way after a set timeout so that we give the server time to restore itself. The resource should re-attempt a request automatically (without additional high-level code) if the state changes from closed to open/half-open.

Since changes to an api's circuit do directly impact values/resources & aren't simple reloads, we should manage our state with signals as far as possible. Anyway that's enough of an 'outline'...let's get implementing!

```typescript
// circuit-breaker.ts
import { computed, effect, Signal, signal, untracked } from "@angular/core";

type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type CircuitBreaker = {
  isClosed: Signal<boolean>;
  status: Signal<CircuitBreakerState>;
  fail: () => void;
  success: () => void;
  halfOpen: () => void;
  destroy: () => void;
};

// false allows for opt out of circuit breaker, full CircuitBreaker allows sharing between multiple resources
export type CircuitBreakerOptions = false | CircuitBreaker | { treshold?: number; timeout?: number };

// allow for top level creation (for example in a service)
function internalCeateCircuitBreaker(treshold = 5, resetTimeout = 30000): CircuitBreaker {
  const halfOpen = signal(false);
  const failureCount = signal(0);

  const status = computed<CircuitBreakerState>(() => {
    if (failureCount() >= treshold) return "CLOSED";
    return halfOpen() ? "HALF_OPEN" : "OPEN";
  });

  const isClosed = computed(() => status() === "CLOSED");

  const success = () => {
    failureCount.set(0);
    halfOpen.set(false);
  };

  const tryOnce = () => {
    if (!untracked(isClosed)) return;
    halfOpen.set(true);
    failureCount.set(treshold - 1);
  };

  const effectRef = effect((cleanup) => {
    if (!isClosed()) return;

    const timeout = setTimeout(tryOnce, resetTimeout);

    return cleanup(() => clearTimeout(timeout));
  });

  const fail = () => {
    failureCount.set(failureCount() + 1);
    halfOpen.set(false);
  };

  return {
    status,
    isClosed,
    fail,
    success,
    halfOpen: tryOnce,
    destroy: () => effectRef.destroy(),
  };
}

function createNeverBrokenCircuitBreaker(): CircuitBreaker {
  return {
    isClosed: computed(() => false),
    status: signal("OPEN"),
    fail: () => {
      // noop
    },
    success: () => {
      // noop
    },
    halfOpen: () => {
      // noop
    },
    destroy: () => {
      // noop
    },
  };
}

export function createCircuitBreaker(opt?: CircuitBreakerOptions): CircuitBreaker {
  if (opt === false) return createNeverBrokenCircuitBreaker();

  if (opt && "isClosed" in opt) return opt;

  return internalCeateCircuitBreaker(opt?.treshold, opt?.timeout);
}
```

```typescript
// We add CircuitBreaker options to our options type

export type ExtendedResourceOptions<TResult, TRaw = TResult> = {
  ...rest
  circuitBreaker?: CircuitBreakerOptions
}


// We also finaly use our type extension to add a disabled signal, this allows us to react to CircutBreaker closing within our UI, by say disabling buttons
export type ExtendedResourceRef<TResult> = HttpResourceRef<TResult> & {
  disabled: Signal<boolean>;
};

// And we integrate it within the function itself.


export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendResourceOptions<TResult, TRaw>
): ExtendedResourceRef<TResult | undefined> {
  const cb = createCircuitBreaker(options?.circuitBreaker);

  const stableRequest = computed(
    () => {
      // returning undefined disables this resource
      if (cb.isClosed()) return undefined;
      return request();
    },
    {
      equal: createEqualRequest(options?.equal),
    }
  );

  ...other resource code


  // iterate circuit breaker state, is effect as a computed would cause a circular dependency (resource -> cb -> resource)
  const cbEffectRef = effect(() => {
    const status = resource.status();
    if (status === ResourceStatus.Error) cb.fail();
    else if (status === ResourceStatus.Resolved) cb.success();
  });

  return {
    ...resource,
    disabled: computed(() => cb.isClosed() || stableRequest() === undefined), // also disabled if for some reason the returned request is still undefined
    reload: () => {
      cb.halfOpen(); // open the circuit for manual reload
      return resource.reload();
    },
    destroy: () => {
      cbEffectRef.destroy();
      cb.destroy();
      resource.destroy();
    },
  };
```

## Caching - the "hard" stuff

Rather luckily we are still using a single-threaded language, so we can create a simple cache without too much difficulty. You can replace this with any cache implementation really such as unstorage or even tanstack's QueryCache...as long as it has a way of communicating _changes_ to certain keys, it should be fine. For best results we should however stick with signals. I've also used the `mutable` primitive from [Part 1]() for performance reasons, feel free to replace it with a normal signal & destructure if you feel more comfortable with that :).

```typescript
// cache.ts
import { HttpEvent } from "@angular/common/http";
import { computed, inject, Injector, InjectionToken, Provider, Signal, untracked } from "@angular/core";
import { Subject } from "rxjs";
import { v7 } from "uuid";
import { mutable } from "./mutable";

type LRUCleanupType = {
  type: "lru";
  checkInterval: number;
  maxSize: number;
};

type OldsetCleanupType = {
  type: "oldest";
  checkInterval: number;
  maxSize: number;
};

type CacheEntry<T> = {
  value: T;
  created: number;
  stale: number;
  useCount: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

export type CleanupType = LRUCleanupType | OldsetCleanupType;

const ONE_DAY = 1000 * 60 * 60 * 24;
const ONE_HOUR = 1000 * 60 * 60;

const DEFAULT_CLEANUP_OPT = {
  type: "lru",
  maxSize: 200,
  checkInterval: ONE_HOUR,
} satisfies LRUCleanupType;

export class Cache<T> {
  private readonly internal = mutable(new Map<string, CacheEntry<T>>());
  private readonly destroy$ = new Subject<void>();
  private readonly cleanupOpt: CleanupType;

  constructor(
    private readonly ttl: number = ONE_DAY,
    private readonly staleTime: number = ONE_HOUR,
    cleanupOpt: Partial<CleanupType> = {
      type: "lru",
      maxSize: 1000,
      checkInterval: 1000 * 60 * 60, // 1 hour
    }
  ) {
    this.cleanupOpt = {
      ...DEFAULT_CLEANUP_OPT,
      ...cleanupOpt,
    };
    if (this.cleanupOpt.maxSize <= 0) throw new Error("maxSize must be greater than 0");

    // cleanup cache based on provided options regularly
    const cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupOpt.checkInterval);

    const destroyId = v7();

    // cleanup if object is garbage collected, this is because the cache can be quite large from a memory standpoint & we dont want all that floating garbage
    const registry = new FinalizationRegistry((id: string) => {
      if (id === destroyId) {
        clearInterval(cleanupInterval);
        this.destroy$.next();
      }
    });

    registry.register(this, destroyId);
  }

  private getInternal(key: () => string | null): Signal<CacheEntry<T> | null> {
    const keySignal = computed(() => key());

    return computed(() => {
      const key = keySignal();
      if (!key) return null;
      const found = this.internal().get(key);
      if (!found || found.expiresAt <= Date.now()) return null;
      found.useCount++;
      return found;
    });
  }

  getUntracked(key: string): CacheEntry<T> | null {
    return untracked(this.getInternal(() => key));
  }

  get(key: () => string | null): Signal<CacheEntry<T> | null> {
    return this.getInternal(key);
  }

  store(key: string, value: T, staleTime = this.staleTime, ttl = this.ttl) {
    const entry = this.getUntracked(key);
    if (entry) {
      clearTimeout(entry.timeout); // stop invalidation
    }

    const prevCount = entry?.useCount ?? 0;

    this.internal.mutate((map) => {
      map.set(key, {
        value,
        created: entry?.created ?? Date.now(),
        useCount: prevCount + 1,
        stale: Date.now() + staleTime,
        expiresAt: Date.now() + ttl,
        timeout: setTimeout(() => this.invalidate(key), ttl),
      });
      return map;
    });
  }

  invalidate(key: string) {
    const entry = this.getUntracked(key);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.internal.mutate((map) => {
      map.delete(key);
      return map;
    });
  }

  private cleanup() {
    if (untracked(this.internal).size <= this.cleanupOpt.maxSize) return;

    const sorted = Array.from(untracked(this.internal).entries()).toSorted((a, b) => {
      if (this.cleanupOpt.type === "lru") {
        return a[1].useCount - b[1].useCount; // least used first
      } else {
        return a[1].created - b[1].created; // oldest first
      }
    });

    const keepCount = Math.floor(this.cleanupOpt.maxSize / 2);

    const removed = sorted.slice(0, sorted.length - keepCount);
    const keep = sorted.slice(removed.length, sorted.length);

    removed.forEach(([, e]) => {
      clearTimeout(e.timeout);
    });

    this.internal.set(new Map(keep));
  }
}

type CacheOptions = {
  ttl?: number;
  staleTime?: number;
  cleanup?: Partial<CleanupType>;
};

const CLIENT_CACHE_TOKEN = new InjectionToken<Cache<HttpEvent<unknown>>>("INTERNAL_CLIENT_CACHE");

export function provideCache(opt?: CacheOptions): Provider {
  return {
    provide: CLIENT_CACHE_TOKEN,
    useValue: new Cache(opt?.ttl, opt?.staleTime, opt?.cleanup),
  };
}

export function injectCache(injector?: Injector) {
  return injector ? injector.get(CLIEANT_CACHE_TOKEN) : inject(CLIENT_CACHE_TOKEN);
}
```

```typescript
// cache.interceptor.ts
import { HttpContext, HttpContextToken, type HttpEvent, type HttpHandlerFn, type HttpInterceptorFn, type HttpRequest, HttpResponse } from "@angular/common/http";
import { Observable, of, tap } from "rxjs";
import { injectCache } from "./cache";

type CacheEntryOptions = {
  key?: string;
  ttl?: number;
  staleTime?: number;
  cache: boolean;
};

const CACHE_CONTEXT = new HttpContextToken<CacheEntryOptions>(() => ({
  cache: false,
}));

export function setCacheContext(
  ctx = new HttpContext(),
  opt: Omit<CacheEntryOptions, "cache" | "key"> & {
    key: Required<CacheEntryOptions>["key"];
  }
) {
  return ctx.set(CACHE_CONTEXT, { ...opt, cache: true });
}

function getCacheContext(ctx: HttpContext): CacheEntryOptions {
  return ctx.get(CACHE_CONTEXT);
}

export function createCacheInterceptor(allowedMethods = ["GET", "HEAD", "OPTIONS"]): HttpInterceptorFn {
  const CACHE_METHODS = new Set<string>(allowedMethods);

  return (req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> => {
    const cache = injectCache();

    if (!CACHE_METHODS.has(req.method)) return next(req);
    const opt = getCacheContext(req.context);

    if (!opt.cache) return next(req);

    const key = opt.key ?? req.urlWithParams;
    const entry = cache.getUntracked(key);

    // If the entry is not stale, return it
    if (entry && entry.stale > Date.now()) return of(entry.value);

    // resource itself handles case of showing stale data...the request must process as this will "refresh said data"

    return next(req).pipe(
      tap((e) => {
        if (e instanceof HttpResponse && e.ok) {
          cache.store(key, e, opt.staleTime, opt.ttl);
        }
      })
    );
  };
}
```

```typescript
// persist-values.ts
export function persistResourceValues<T>(resource: HttpResourceRef<T>, hasCachedValue: Signal<boolean>, persist = false, equal?: ValueEqualityFn<T>): HttpResourceRef<T> {
  if (!persist) return resource;

  return {
    ...resource,
    statusCode: presist<number | undefined>(resource.statusCode, resource.isLoading),
    headers: presist<HttpHeaders | undefined>(resource.headers, resource.isLoading),
    value: presist<T>(
      resource.value,
      computed(() => resource.isLoading() || !hasCachedValue()), // should show cached value if available
      equal
    ),
  };
}
```

```typescript
// has-slow-connection.ts

// check if user on slow mobile connection
export function hasSlowConnection() {
  if ("connection" in window.navigator && typeof window.navigator.connection === "object" && !!window.navigator.connection && "effectiveType" in window.navigator.connection && typeof window.navigator.connection.effectiveType === "string") return window.navigator.connection.effectiveType.endsWith("2g");

  return false;
}
```

```typescript
// extended-resource.ts

// first we add the new configuration options
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
  ...rest
  cache?: ResourceCacheOptions; // Cache options, undefined = no cache
};

// add prefetch to Ref
export type ExtendedResourceRef<TResult> = HttpResourceRef<TResult> & {
  disabled: Signal<boolean>;
  prefetch: (req?: Partial<HttpResourceRequest>) => Promise<void>;
};

export function extendedResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendResourceOptions<TResult, TRaw>
): ExtendedResourceRef<TResult | undefined> {
  const cache = injectCache(options?.injector);


  ...otherCode


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

  // we now use the request, with the added cache context for our http call, so that the interceptor can update it
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

  // value is updated every time cachedValue changes (due to other resources), falls back to resource.value (defaultValue if provided)
  const value = options?.cache
    ? toWritable(
        computed((): TResult => {
          return cachedValue() ?? resource.value();
        }),
        resource.value.set,
        resource.value.update
      )
    : resource.value;

  ...otherCode

  resource = persistResourceValues<TResult>(
    { ...resource, value }, // pass cached value to be 'persisted' in ui as well
    computed(() => !!cachedValue()),
    options?.keepPrevious,
    options?.equal
  );

  ...otherCode


  // we override the set function so that the cache is also updated when manually setting (propagating any state changes throughout our app)
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
      // do not prefetch if no cache or if on slow mobile connection
      if (!options?.cache || hasSlowConnection()) return Promise.resolve();

      const request = untracked(cachedRequest);
      if (!request) return Promise.resolve();

      const prefetchRequest = {
        ...request,
        ...partial,
      };

      try {
        // no need to store response to variable, it is stored in cache due to interceptor
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

```

Well that was quite the chunk of code :) As you can see we're doing a few things here:

- We're setting HttpResponse objects in the cache for valid requests
- If we make a request and we find an entry that is not expired and not stale, we return it
- If we find a value that is stale, we return it, but also make a request so that it is refreshed _behind the hood_
- If we dont find a value, we, of course, just make a request
- If multiple resources are _listening_ to the same key, they are all updated to the latest value, when a new resource is instantiated/reloaded/manually set
- We can _prefill_ the cache by calling `prefetch()`, which can be useful when say hovering over a link, or fetching the next page for the table. This is disabled if the resource doesn't have a cache option (as we can't store the response anywhere), or if the user is on a slow mobile connection, to not overload it.
- We're using signals thorughout the state, so the _reactive graph's_ dependencies are solidly set & the scheduler can figure it all out.

One thing though, we had to split some logic between the interceptor (fresh data & setting cache) and the resource itself, this is due to the .isLoading signal within the resource. If we simply returned the stale data from the interceptor the status of the resource would no longer be loading, as the request would have been completed, as far as it's concerned. This is why we separated this logic. I'll admit it's not the cleanest approach, but sometimes we just have to get our hands dirty :).

## Mutations

Since we now have a solid foundation for _getting_ data to our client, let's start thinking about how we're going to mutate that state. Personally I like tanstack's approach here, where a `mutation` is setup with various callbacks, such as onError, & returns a function which is called with the next request whenever needed. So far this has proven quite robust in our production & honestly what I find to be the _easiest_ way of managing complexity. I propose we setup 4 callbacks:

- onMutate: will be called when the function is called (before request)
- onError: will be called when an error happens
- onSuccess: will be called when the request is resolved
- onSettled: will be called when the request is finished (error or success)

Additionally onMutate should enable us to _set up_ a context variable, which is then passed to the other functions, this allows us to create logic to reset state on failure and such. Anywhere let's get into it, this one is pretty straightforward, since we setup `extendedResource` so well.

```typescript
import { type HttpResourceRequest } from "@angular/common/http";
import { computed, DestroyRef, inject, ResourceStatus, Signal, signal } from "@angular/core";
import { takeUntilDestroyed, toObservable } from "@angular/core/rxjs-interop";
import { combineLatestWith, filter, map } from "rxjs";
import { createEqualRequest } from "./equal-request";
import { extendedResource, type ExtendedResourceRef, type ExtendResourceOptions } from "./extended-resource";

type StatusResult<TResult> =
  | {
      status: ResourceStatus.Error;
      error: unknown;
    }
  | {
      status: ResourceStatus.Resolved;
      value: TResult;
    };

export type MutationResourceOptions<TResult, TRaw = TResult, TCTX = void> = Omit<
  ExtendResourceOptions<TResult, TRaw>,
  "onError" | "keepPrevious" | "refresh" | "cache" // we can't keep previous values, refresh or cache mutations as they are meant to be one-off operations
> & {
  onMutate?: (value: NoInfer<TResult>) => TCTX;
  onError?: (error: unknown, ctx: NoInfer<TCTX>) => void;
  onSuccess?: (value: NoInfer<TResult>, ctx: NoInfer<TCTX>) => void;
  onSettled?: (ctx: NoInfer<TCTX>) => void;
};

export type MutationResourceRef<TResult> = Omit<
  ExtendedResourceRef<TResult>,
  "prefetch" | "value" | "hasValue" | "set" | "update" // we don't allow manually viewing the returned data or updating it manually, prefetching a mutation also doesn't make any sense
> & {
  mutate: (value: Omit<HttpResourceRequest, "body"> & { body: TResult }) => void;
  current: Signal<(Omit<HttpResourceRequest, "body"> & { body: TResult }) | null>;
};

export function mutationResource<TResult, TRaw = TResult, TCTX = void>(request: () => Omit<Partial<HttpResourceRequest>, "body"> | undefined, options: MutationResourceOptions<TResult, TRaw, TCTX>): MutationResourceRef<TResult> {
  const equal = createEqualRequest(options.equal);

  const baseRequest = computed(() => request(), {
    equal,
  });

  const nextRequest = signal<(Omit<HttpResourceRequest, "body"> & { body: TResult }) | null>(null, {
    equal: (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return equal(a, b);
    },
  });

  const req = computed((): HttpResourceRequest | undefined => {
    const nr = nextRequest();
    if (!nr) return;

    const base = baseRequest();

    const url = base?.url ?? nr.url;
    if (!url) return;

    return {
      ...base,
      ...nr,
      url,
    };
  });

  const { onMutate, onError, onSuccess, onSettled, ...rest } = options;

  const resource = extendedResource<TResult, TRaw>(req, {
    ...rest,
    defaultValue: null as TResult, // doesnt matter since .value is not accessible
  });

  let ctx: TCTX = undefined as TCTX;

  const destroyRef = options.injector ? options.injector.get(DestroyRef) : inject(DestroyRef);

  const error$ = toObservable(resource.error);
  const value$ = toObservable(resource.value);

  const statusSub = toObservable(resource.status)
    .pipe(
      combineLatestWith(error$, value$),
      map(([status, error, value]): StatusResult<TResult> | null => {
        if (status === ResourceStatus.Error && error) {
          return {
            status: ResourceStatus.Error,
            error,
          };
        }

        if (status === ResourceStatus.Resolved) {
          return {
            status: ResourceStatus.Resolved,
            value,
          };
        }

        return null;
      }),
      filter((v) => v !== null),
      takeUntilDestroyed(destroyRef)
    )
    .subscribe((result) => {
      if (result.status === ResourceStatus.Error) onError?.(result.error, ctx);
      else onSuccess?.(result.value, ctx);

      onSettled?.(ctx);
      ctx = undefined as TCTX;
      nextRequest.set(null);
    });

  return {
    ...resource,
    destroy: () => {
      statusSub.unsubscribe();
      resource.destroy();
    },
    mutate: (value) => {
      ctx = onMutate?.(value.body as TResult) as TCTX;
      nextRequest.set(value);
    },
    current: nextRequest,
  };
}
```

### Optimistic updates

As you can see the above interface allows for easy updates to other existing resources, as such we can also provide a _helper_ option (it could also be a separate function if you prefer) to optimistically update another resource of the same type (say we have a getById & a patch mutation resource).

```typescript
export type MutationResourceOptions<
  TResult,
  TRaw = TResult,
  TCTX = void
> = Omit<
  ExtendResourceOptions<TResult, TRaw>,
  'onError' | 'keepPrevious' | 'refresh' | 'cache' // we can't keep previous values, refresh or cache mutations as they are meant to be one-off operations
> & {
  ...rest
  optimisticlyUpdate?: HttpResourceRef<TResult>;
};



export function mutationResource<TResult, TRaw = TResult, TCTX = void>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined,
  options: MutationResourceOptions<TResult, TRaw, TCTX>
): MutationResourceRef<TResult> {

  ...rest

 const {
    onMutate: providedOnMutate,
    onError: providedOnError,
    onSuccess: providedOnSuccess,
    onSettled,
    ...rest
  } = options;

  let prevOptimisticValue: TResult | null = null;

  const optimisticResource = options.optimisticlyUpdate;

  const onMutate = optimisticResource
    ? (val: TResult) => {
        prevOptimisticValue = untracked(optimisticResource.value);
        optimisticResource.set(val);
        return providedOnMutate?.(val);
      }
    : providedOnMutate;

  const onError = optimisticResource
    ? (err: unknown, ctx: TCTX) => {
        if (prevOptimisticValue !== null)
          optimisticResource.set(prevOptimisticValue);

        providedOnError?.(err, ctx);
      }
    : providedOnError;

  const onSuccess = optimisticResource
    ? (val: TResult, ctx: TCTX) => {
        optimisticResource.set(val);
        providedOnSuccess?.(val, ctx);
      }
  ...rest
}
```

Personally I prefer to be slightly more manual about these things, so I'd leave the interface as it's outlined originally & simple use the provided callbacks to update state as I see fit. After all, we save very little code this way. Here's an example which is slightly more advanced (although it uses slightly different primitives, they are conceptually similar enough); [event-definition.store.ts](https://github.com/mihajm/event7/blob/master/libs/event-definition/client/src/lib/event-definition.store.ts). Here we're similarly doing an optimistic update, but giving the user both a "retry" and a "re-open" option. This is dues to the form itself being within a dialog, which we close before the update. Since we preserve the form state with our primitives from [Part 2](https://dev.to/mihamulec/fun-grained-reactivity-in-angular-part-2-forms-e84) we can simply re-open the dialog and revert the data, making sure the user never loses anything :).

## Bonus - Deduplication

Alright time for a bit of a bonus feature: request deduplication. If for some reason, we make a request to an url, while another to the same one is still in flight...let's not call the server twice. This allows us to use our resources in a more _worry-free_ manner, just like tanstack.

_Originally this interceptor was inspired by this article [Request Deduplication in Angular](https://dev.to/kasual1/request-deduplication-in-angular-3pd8). In fact the code is still quite similar, since it works well. I thought I'd add it here as well, since it *roundes out* our feature set nicely._

```typescript
// Heavily inpsired by: https://dev.to/kasual1/request-deduplication-in-angular-3pd8
import { HttpContext, HttpContextToken, HttpInterceptorFn, type HttpEvent, type HttpHandlerFn, type HttpRequest } from "@angular/common/http";
import { finalize, shareReplay, type Observable } from "rxjs";

const NO_DEDUPE = new HttpContextToken<boolean>(() => false);

export function noDedupe(ctx: HttpContext = new HttpContext()) {
  return ctx.set(NO_DEDUPE, true);
}

export function createDedupeRequestsInterceptor(allowed = ["GET", "DELETE", "PUT", "HEAD", "OPTIONS"]): HttpInterceptorFn {
  const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

  const DEDUPE_METHODS = new Set<string>(allowed);

  return (req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> => {
    if (!DEDUPE_METHODS.has(req.method) || req.context.get(NO_DEDUPE)) return next(req);

    const found = inFlight.get(req.urlWithParams);

    if (found) return found;

    const request = next(req).pipe(
      finalize(() => inFlight.delete(req.urlWithParams)),
      shareReplay()
    );
    inFlight.set(req.urlWithParams, request);

    return request;
  };
}
```

Well, that's all for now. I'm hope you find these _helpers/extensions_ as useful as we do! Other than that, i'll see you in the next article, happy coding! 🚀
