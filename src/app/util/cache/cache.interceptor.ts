import {
  HttpContext,
  HttpContextToken,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { map, Observable, of, tap } from 'rxjs';
import { injectCache } from './cache';

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
  opt: Omit<CacheEntryOptions, 'cache' | 'key'> & {
    key: Required<CacheEntryOptions>['key'];
  }
) {
  return ctx.set(CACHE_CONTEXT, { ...opt, cache: true });
}

function getCacheContext(ctx: HttpContext): CacheEntryOptions {
  return ctx.get(CACHE_CONTEXT);
}

type ResolvedCacheControl = {
  noStore: boolean;
  noCache: boolean;
  mustRevalidate: boolean;
  immutable: boolean;
  maxAge: number | null;
  staleWhileRevalidate: number | null;
};

function parseCacheControlHeader(
  req: HttpResponse<unknown>
): ResolvedCacheControl {
  const header = req.headers.get('Cache-Control');

  let sMaxAge: number | null = null;
  const directives: ResolvedCacheControl = {
    noStore: false,
    noCache: false,
    mustRevalidate: false,
    immutable: false,
    maxAge: null,
    staleWhileRevalidate: null,
  };

  if (!header) return directives;

  const parts = header.split(',');

  for (const part of parts) {
    const [unparsedKey, value] = part.trim().split('=');
    const key = unparsedKey.trim().toLowerCase();

    switch (key) {
      case 'no-store':
        directives.noStore = true;
        break;
      case 'no-cache':
        directives.noCache = true;
        break;
      case 'must-revalidate':
      case 'proxy-revalidate':
        directives.mustRevalidate = true;
        break;
      case 'immutable':
        directives.immutable = true;
        break;
      case 'max-age':
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) directives.maxAge = parsedValue;
        break;
      case 's-max-age': {
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) sMaxAge = parsedValue;
        break;
      }
      case 'stale-while-revalidate': {
        if (!value) break;
        const parsedValue = parseInt(value, 10);
        if (!isNaN(parsedValue)) directives.staleWhileRevalidate = parsedValue;
        break;
      }
    }
  }

  // s-max-age takes precedence over max-age
  if (sMaxAge !== null) directives.maxAge = sMaxAge;

  // if no store nothing else is relevant
  if (directives.noStore)
    return {
      noStore: true,
      noCache: false,
      mustRevalidate: false,
      immutable: false,
      maxAge: null,
      staleWhileRevalidate: null,
    };

  // max age does not apply to immutable resources
  if (directives.immutable)
    return {
      ...directives,
      maxAge: null,
    };

  return directives;
}

function resolveTimings(
  cacheControl: ResolvedCacheControl,
  staleTime?: number,
  ttl?: number
): { staleTime?: number; ttl?: number } {
  const timings = {
    staleTime,
    ttl,
  };

  if (cacheControl.immutable)
    return {
      staleTime: Infinity,
      ttl: Infinity,
    };

  // if no-cache is set, we must always revalidate
  if (cacheControl.noCache || cacheControl.mustRevalidate)
    timings.staleTime = 0;

  if (cacheControl.staleWhileRevalidate !== null)
    timings.staleTime = cacheControl.staleWhileRevalidate;

  if (cacheControl.maxAge !== null) timings.ttl = cacheControl.maxAge * 1000;

  // if stale-while-revalidate is set, we must revalidate after that time at the latest, but we can still serve the stale data
  if (cacheControl.staleWhileRevalidate !== null) {
    const ms = cacheControl.staleWhileRevalidate * 1000;
    if (timings.staleTime === undefined || timings.staleTime > ms)
      timings.staleTime = ms;
  }

  return timings;
}

export function createCacheInterceptor(
  allowedMethods = ['GET', 'HEAD', 'OPTIONS']
): HttpInterceptorFn {
  const CACHE_METHODS = new Set<string>(allowedMethods);

  return (
    req: HttpRequest<unknown>,
    next: HttpHandlerFn
  ): Observable<HttpEvent<unknown>> => {
    const cache = injectCache();

    if (!CACHE_METHODS.has(req.method)) return next(req);
    const opt = getCacheContext(req.context);

    if (!opt.cache) return next(req);

    const key = opt.key ?? req.urlWithParams;
    const entry = cache.getUntracked(key); // null if expired or not found

    // If the entry is not stale, return it
    if (entry && !entry.isStale) return of(entry.value);

    // resource itself handles case of showing stale data...the request must process as this will "refresh said data"

    const eTag = entry?.value.headers.get('ETag');
    const lastModified = entry?.value.headers.get('Last-Modified');

    if (eTag) {
      req = req.clone({ setHeaders: { 'If-None-Match': eTag } });
    }

    if (lastModified) {
      req = req.clone({ setHeaders: { 'If-Modified-Since': lastModified } });
    }

    return next(req).pipe(
      tap((event) => {
        if (event instanceof HttpResponse && event.ok) {
          const cacheControl = parseCacheControlHeader(event);
          if (cacheControl.noStore) return;

          const { staleTime, ttl } = resolveTimings(
            cacheControl,
            opt.staleTime,
            opt.ttl
          );

          cache.store(key, event, staleTime, ttl);
        }
      }),
      map((event) => {
        // handle 304 responses due to eTag/last-modified
        if (event instanceof HttpResponse && event.status === 304 && entry) {
          return entry.value;
        }

        return event;
      })
    );
  };
}
