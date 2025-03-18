import { HttpEvent } from '@angular/common/http';
import { inject, InjectionToken, Provider } from '@angular/core';
import {
  BehaviorSubject,
  combineLatestWith,
  map,
  Observable,
  Subject,
  takeUntil,
} from 'rxjs';
import { v7 } from 'uuid';

type LRUCleanupType = {
  type: 'lru';
  checkInterval: number;
  maxSize: number;
};

type OldsetCleanupType = {
  type: 'oldest';
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

const DEFAULT_CLEANUP_OPT = {
  type: 'lru',
  maxSize: 1000,
  checkInterval: 1000 * 60 * 60, // 1 hour
} satisfies LRUCleanupType;

const ONE_DAY = 1000 * 60 * 60 * 24;
const ONE_HOUR = 1000 * 60 * 60;

export class Cache<T> {
  private readonly internal$ = new BehaviorSubject(
    new Map<string, CacheEntry<T>>()
  );
  private readonly destroy$ = new Subject<void>();
  private readonly cleanupOpt: CleanupType;

  constructor(
    private readonly ttl: number = ONE_DAY,
    private readonly staleTime: number = ONE_HOUR,
    cleanupOpt: Partial<CleanupType> = {
      type: 'lru',
      maxSize: 1000,
      checkInterval: 1000 * 60 * 60, // 1 hour
    }
  ) {
    this.cleanupOpt = {
      ...DEFAULT_CLEANUP_OPT,
      ...cleanupOpt,
    };
    if (this.cleanupOpt.maxSize <= 0)
      throw new Error('maxSize must be greater than 0');

    const cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupOpt.checkInterval);

    const destroyId = v7();

    const registry = new FinalizationRegistry((id: string) => {
      if (id === destroyId) {
        clearInterval(cleanupInterval);
        this.destroy$.next();
      }
    });

    registry.register(this, destroyId);
  }

  getEntry(key: string) {
    const found = this.internal$.value.get(key);
    if (!found) return null;
    if (found.expiresAt <= Date.now()) {
      clearTimeout(found.timeout);
      this.internal$.value.delete(key);
      return null;
    }
    return found;
  }

  private getEntryAndStale(key: string) {
    const found = this.getEntry(key);
    if (!found) return null;

    return {
      entry: found,
      isStale: found.stale < Date.now(),
    };
  }

  get(key: string | null) {
    if (!key) return null;
    const found = this.getEntryAndStale(key);
    if (!found) return null;
    found.entry.useCount++;

    return { value: found.entry.value, isStale: found.isStale };
  }

  store(key: string, value: T) {
    this.storeWithInvalidation(key, value, this.staleTime, this.ttl);
  }

  storeWithInvalidation(
    key: string,
    value: T,
    staleTime: number = this.staleTime,
    ttl: number = this.ttl
  ) {
    const entry = this.getEntry(key);
    if (entry) {
      clearTimeout(entry.timeout);
    }

    const prevCount = entry?.useCount ?? 0;

    this.internal$.value.set(key, {
      value,
      created: entry?.created ?? Date.now(),
      useCount: prevCount + 1,
      stale: Date.now() + staleTime,
      expiresAt: Date.now() + this.ttl,
      timeout: setTimeout(() => this.invalidate(key), ttl),
    });

    this.internal$.next(this.internal$.value);

    this.cleanup();
  }

  invalidate(key: string) {
    const entry = this.getEntry(key);
    if (entry) {
      clearTimeout(entry.timeout);
      this.internal$.value.delete(key);
      this.internal$.next(this.internal$.value);
    }
  }

  changes$(key$: Observable<string | null>) {
    return key$.pipe(
      combineLatestWith(this.internal$),
      map(([key]) => {
        if (!key) return null;
        const found = this.get(key);
        return found?.value ?? null;
      }),
      takeUntil(this.destroy$)
    );
  }

  private cleanup() {
    if (this.internal$.value.size <= this.cleanupOpt.maxSize) return;

    const sorted = Array.from(this.internal$.value.entries()).toSorted(
      (a, b) => {
        if (this.cleanupOpt.type === 'lru') {
          return a[1].useCount - b[1].useCount; // least used first
        } else {
          return a[1].created - b[1].created; // oldest first
        }
      }
    );

    const keepCount = Math.floor(this.cleanupOpt.maxSize / 2);

    const removed = sorted.slice(0, sorted.length - keepCount);
    const keep = sorted.slice(removed.length, sorted.length);

    removed.forEach(([, e]) => {
      clearTimeout(e.timeout);
    });

    this.internal$.next(new Map(keep));
  }
}

type CacheOptions = {
  ttl?: number;
  staleTime?: number;
  cleanup?: Partial<CleanupType>;
};

const CLIENT_CACHE_TOKEN = new InjectionToken<Cache<HttpEvent<unknown>>>(
  'INTERNAL_CLIENT_CACHE'
);

export function provideCache(opt?: CacheOptions): Provider {
  return {
    provide: CLIENT_CACHE_TOKEN,
    useValue: new Cache(opt?.ttl, opt?.staleTime, opt?.cleanup),
  };
}

export function injectCache() {
  return inject(CLIENT_CACHE_TOKEN);
}
