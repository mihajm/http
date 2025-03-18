import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import {
  createCacheInterceptor,
  createDedupeRequestsInterceptor,
  provideCache,
} from './util';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideCache(),
    provideHttpClient(
      withInterceptors([
        createDedupeRequestsInterceptor(),
        createCacheInterceptor(),
      ])
    ),
    provideRouter(routes),
  ],
};
