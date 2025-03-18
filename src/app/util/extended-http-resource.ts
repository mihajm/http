import {
  HttpHeaders,
  httpResource,
  HttpResourceOptions,
  HttpResourceRef,
  HttpResourceRequest,
} from '@angular/common/http';
import { computed, WritableSignal } from '@angular/core';
import { equalRequest } from './equal-request';
import { keepPrevious } from './keep-previous';

export type ExtendedHttpResourceOptions<
  TResult,
  TRaw = TResult
> = HttpResourceOptions<TResult, TRaw> & {
  keepPrevious?: boolean;
};

export type ExtendedHttpResourceRef<TResult> = HttpResourceRef<TResult>;

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options: ExtendedHttpResourceOptions<TResult, TRaw> & {
    defaultValue: NoInfer<TResult>;
  }
): ExtendedHttpResourceRef<TResult>;

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendedHttpResourceOptions<TResult, TRaw>
): ExtendedHttpResourceRef<TResult | undefined>;

export function extendedHttpResource<TResult, TRaw = TResult>(
  request: () => HttpResourceRequest | undefined,
  options?: ExtendedHttpResourceOptions<TResult, TRaw>
): ExtendedHttpResourceRef<TResult | undefined> {
  const req = computed(() => request(), {
    equal: equalRequest,
  });

  const resource = httpResource<TResult>(req, {
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: options?.parse as any,
  });

  return {
    ...resource,
    statusCode: keepPrevious<number | undefined>(
      resource.statusCode,
      resource.isLoading,
      options?.keepPrevious
    ),
    headers: keepPrevious<HttpHeaders | undefined>(
      resource.headers,
      resource.isLoading,
      options?.keepPrevious
    ),
    value: keepPrevious<TResult>(
      resource.value as WritableSignal<TResult>,
      resource.isLoading,
      options?.keepPrevious,
      options?.equal
    ),
  };
}
