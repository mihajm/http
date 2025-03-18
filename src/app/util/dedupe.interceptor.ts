// Heavily inspired by: https://dev.to/kasual1/request-deduplication-in-angular-3pd8

import {
  HttpContext,
  HttpContextToken,
  HttpInterceptorFn,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpRequest,
} from '@angular/common/http';
import { finalize, shareReplay, type Observable } from 'rxjs';

const NO_DEDUPE = new HttpContextToken<boolean>(() => false);

export function noDedupe(ctx: HttpContext = new HttpContext()) {
  return ctx.set(NO_DEDUPE, true);
}

export function createDedupeRequestsInterceptor(
  allowed = ['GET', 'DELETE', 'HEAD', 'OPTIONS']
): HttpInterceptorFn {
  const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

  const DEDUPE_METHODS = new Set<string>(allowed);

  return (
    req: HttpRequest<unknown>,
    next: HttpHandlerFn
  ): Observable<HttpEvent<unknown>> => {
    if (!DEDUPE_METHODS.has(req.method) || req.context.get(NO_DEDUPE))
      return next(req);

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
