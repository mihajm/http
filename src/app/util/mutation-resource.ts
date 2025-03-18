import {
  HttpResourceRef,
  type HttpResourceRequest,
} from '@angular/common/http';
import {
  computed,
  DestroyRef,
  inject,
  ResourceStatus,
  Signal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { combineLatestWith, filter, map } from 'rxjs';
import { createEqualRequest } from './equal-request';
import {
  extendedResource,
  type ExtendedResourceRef,
  type ExtendResourceOptions,
} from './extended-resource';

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
  ExtendResourceOptions<TResult, TRaw>,
  'onError' | 'keepPrevious' | 'refresh' | 'cache' // we can't keep previous values, refresh or cache mutations as they are meant to be one-off operations
> & {
  onMutate?: (value: NoInfer<TResult>) => TCTX;
  onError?: (error: unknown, ctx: NoInfer<TCTX>) => void;
  onSuccess?: (value: NoInfer<TResult>, ctx: NoInfer<TCTX>) => void;
  onSettled?: (ctx: NoInfer<TCTX>) => void;
  optimisticlyUpdate?: HttpResourceRef<TResult>;
};

export type MutationResourceRef<TResult> = Omit<
  ExtendedResourceRef<TResult>,
  'prefetch' | 'value' | 'hasValue' | 'set' | 'update' // we don't allow manually viewing the returned data or updating it manually, prefetching a mutation also doesn't make any sense
> & {
  mutate: (
    value: Omit<HttpResourceRequest, 'body'> & { body: TResult }
  ) => void;
  current: Signal<
    (Omit<HttpResourceRequest, 'body'> & { body: TResult }) | null
  >;
};

export function mutationResource<TResult, TRaw = TResult, TCTX = void>(
  request: () => Omit<Partial<HttpResourceRequest>, 'body'> | undefined,
  options: MutationResourceOptions<TResult, TRaw, TCTX>
): MutationResourceRef<TResult> {
  const equal = createEqualRequest(options.equal);

  const baseRequest = computed(() => request(), {
    equal,
  });

  const nextRequest = signal<
    (Omit<HttpResourceRequest, 'body'> & { body: TResult }) | null
  >(null, {
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
    : providedOnSuccess;

  const resource = extendedResource<TResult, TRaw>(req, {
    ...rest,
    defaultValue: null as TResult, // doesnt matter since .value is not accessible
  });

  let ctx: TCTX = undefined as TCTX;

  const destroyRef = options.injector
    ? options.injector.get(DestroyRef)
    : inject(DestroyRef);

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
