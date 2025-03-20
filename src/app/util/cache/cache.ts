import type { HttpResponse } from '@angular/common/http';
import {
  computed,
  inject,
  InjectionToken,
  Injector,
  type Provider,
  type Signal,
  untracked,
} from '@angular/core';
import { v7 } from 'uuid';
import { mutable } from './mutable';

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

const ONE_DAY = 1000 * 60 * 60 * 24;
const ONE_HOUR = 1000 * 60 * 60;

const DEFAULT_CLEANUP_OPT = {
  type: 'lru',
  maxSize: 200,
  checkInterval: ONE_HOUR,
} satisfies LRUCleanupType;

export class Cache<T> {
  private readonly internal = mutable(new Map<string, CacheEntry<T>>());
  private readonly cleanupOpt: CleanupType;

  constructor(
    private readonly ttl: number = ONE_DAY,
    private readonly staleTime: number = ONE_HOUR,
    cleanupOpt: Partial<CleanupType> = {
      type: 'lru',
      maxSize: 1000,
      checkInterval: ONE_HOUR,
    }
  ) {
    this.cleanupOpt = {
      ...DEFAULT_CLEANUP_OPT,
      ...cleanupOpt,
    };
    if (this.cleanupOpt.maxSize <= 0)
      throw new Error('maxSize must be greater than 0');

    // cleanup cache based on provided options regularly
    const cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupOpt.checkInterval);

    const destroyId = v7();

    // cleanup if object is garbage collected, this is because the cache can be quite large from a memory standpoint & we dont want all that floating garbage
    const registry = new FinalizationRegistry((id: string) => {
      if (id === destroyId) {
        clearInterval(cleanupInterval);
      }
    });

    registry.register(this, destroyId);
  }

  private getInternal(
    key: () => string | null
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | null> {
    const keySignal = computed(() => key());

    return computed(() => {
      const key = keySignal();
      if (!key) return null;
      const found = this.internal().get(key);

      const now = Date.now();

      if (!found || found.expiresAt <= now) return null;
      found.useCount++;
      return {
        ...found,
        isStale: found.stale <= now,
      };
    });
  }

  getUntracked(key: string): (CacheEntry<T> & { isStale: boolean }) | null {
    return untracked(this.getInternal(() => key));
  }

  get(
    key: () => string | null
  ): Signal<(CacheEntry<T> & { isStale: boolean }) | null> {
    return this.getInternal(key);
  }

  store(key: string, value: T, staleTime = this.staleTime, ttl = this.ttl) {
    const entry = this.getUntracked(key);
    if (entry) {
      clearTimeout(entry.timeout); // stop invalidation
    }

    const prevCount = entry?.useCount ?? 0;

    // ttl cannot be less than staleTime
    if (ttl < staleTime) staleTime = ttl;

    const now = Date.now();

    this.internal.mutate((map) => {
      map.set(key, {
        value,
        created: entry?.created ?? now,
        useCount: prevCount + 1,
        stale: now + staleTime,
        expiresAt: now + ttl,
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

    const sorted = Array.from(untracked(this.internal).entries()).toSorted(
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

    this.internal.set(new Map(keep));
  }
}

type CacheOptions = {
  ttl?: number;
  staleTime?: number;
  cleanup?: Partial<CleanupType>;
};

const CLIENT_CACHE_TOKEN = new InjectionToken<Cache<HttpResponse<unknown>>>(
  'INTERNAL_CLIENT_CACHE'
);

export function provideCache(opt?: CacheOptions): Provider {
  return {
    provide: CLIENT_CACHE_TOKEN,
    useValue: new Cache(opt?.ttl, opt?.staleTime, opt?.cleanup),
  };
}

export function injectCache(injector?: Injector) {
  return injector
    ? injector.get(CLIENT_CACHE_TOKEN)
    : inject(CLIENT_CACHE_TOKEN);
}
