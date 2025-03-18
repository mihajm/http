import {
  HttpContext,
  HttpContextToken,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable, of, tap } from 'rxjs';
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
