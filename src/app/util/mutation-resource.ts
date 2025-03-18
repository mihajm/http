import { HttpResourceRequest } from '@angular/common/http';
import {
  computed,
  DestroyRef,
  inject,
  ResourceStatus,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { filter, map, Observable, of, switchMap } from 'rxjs';
import { createEqualRequest } from './equal-request';
import {
  extendedHttpResource,
  ExtendedHttpResourceOptions,
  ExtendedHttpResourceRef,
} from './extended-http-resource';

type StatusResult<TResult> =
  | {
      status: ResourceStatus.Error;
      error: unknown;
    }
  | {
      status: ResourceStatus.Resolved;
      value: TResult;
    };

export type MutationResourceOptions<
  TResult,
  TRaw = TResult,
  TCTX = void
> = Omit<
  ExtendedHttpResourceOptions<TResult, TRaw>,
  'onError' | 'keepPrevious' | 'refresh' | 'cache'
> & {
  onMutate?: (value: NoInfer<TResult>) => TCTX;
  onError?: (error: unknown, ctx: NoInfer<TCTX>) => void;
  onSuccess?: (value: NoInfer<TResult>, ctx: NoInfer<TCTX>) => void;
  onSettled?: (ctx: NoInfer<TCTX>) => void;
};

export type MutationResourceRef<TResult> = Omit<
  ExtendedHttpResourceRef<TResult>,
  'prefetch' | 'value' | 'set' | 'update'
> & {
  mutate: (
    value: Omit<HttpResourceRequest, 'body'> & { body: TResult }
  ) => void;
};

export function mutationResource<TResult, TRaw = TResult, TCTX = void>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined,
  options: MutationResourceOptions<TResult, TRaw, TCTX> & {
    defaultValue: NoInfer<TResult>;
  }
): MutationResourceRef<TResult>;

export function mutationResource<TResult, TRaw = TResult, TCTX = void>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined,
  options: MutationResourceOptions<TResult, TRaw, TCTX>
): MutationResourceRef<TResult | undefined>;

export function mutationResource<TResult, TRaw = TResult, TCTX = void>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined,
  options: MutationResourceOptions<TResult, TRaw, TCTX>
): MutationResourceRef<TResult | undefined> {
  const equal = createEqualRequest(options.equal);

  const baseRequest = computed(() => request(), {
    equal,
  });

  const nextRequest = signal<Omit<Partial<HttpResourceRequest>, 'body'> | null>(
    null,
    {
      equal: (a, b) => {
        if (!a && !b) return true;
        if (!a || !b) return false;
        return equal(a, b);
      },
    }
  );

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

  const resource = extendedHttpResource<TResult, TRaw>(req, rest);

  let ctx: TCTX = undefined as TCTX;

  const destroyRef = options.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

  const error = toObservable(resource.error);
  const value = toObservable(resource.value);

  const statusSub = toObservable(resource.status)
    .pipe(
      switchMap((status): Observable<StatusResult<TResult> | null> => {
        if (status === ResourceStatus.Error) {
          return error.pipe(
            map((err) => ({
              error: err,
              status: ResourceStatus.Error,
            }))
          );
        }

        if (status === ResourceStatus.Resolved) {
          return value.pipe(
            map((val) => ({
              value: val as TResult,
              status: ResourceStatus.Resolved,
            }))
          );
        }

        return of(null);
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
  };
}
