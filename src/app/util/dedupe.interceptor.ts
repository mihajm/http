import {
  HttpContext,
  HttpContextToken,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpRequest,
} from '@angular/common/http';
import { finalize, type Observable, shareReplay } from 'rxjs';

const NO_DEDUPE = new HttpContextToken<boolean>(() => false);

export function noDedupe(ctx: HttpContext = new HttpContext()) {
  return ctx.set(NO_DEDUPE, true);
}

export function createDedupeRequestsInterceptor(
  allowed = ['GET', 'DELETE', 'PUT', 'HEAD', 'OPTIONS']
) {
  const inFlight = new Map<string, Observable<HttpEvent<unknown>>>();

  const DEDUPE_METHODS = new Set(allowed);

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
