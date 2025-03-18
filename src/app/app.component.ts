import { HttpClient } from '@angular/common/http';
import { Component, inject, signal, untracked } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { extendedHttpResource } from './util';

type Todo = {
  id: number;
  title: string;
};

@Component({
  selector: 'app-root',
  template: `
    loading: {{ todo.isLoading() }}
    <br />
    title: {{ todo.value().title }}
    <br />

    <br />
    <button
      style="margin-right: 1rem;"
      (click)="prev()"
      [disabled]="id() <= 1 || todo.disabled()"
    >
      Prev
    </button>
    <button (click)="next()" [disabled]="id() >= 5 || todo.disabled()">
      Next
    </button>
  `,
})
export class AppComponent {
  protected readonly id = signal(1);

  protected readonly todo = extendedHttpResource<Todo>(
    () => ({
      url: `https://jsonplaceholder.typicode.com/todos/${
        this.id() > 2 ? 'testeststes' : this.id()
      }`,
    }),
    {
      defaultValue: { id: 0, title: '' },
      keepPrevious: true,
    }
  );

  private readonly client = inject(HttpClient);

  test = toObservable(this.id)
    .pipe(
      switchMap((id) =>
        this.client.get(`https://jsonplaceholder.typicode.com/todos/${id}`)
      )
    )
    .subscribe();

  protected next() {
    if (untracked(this.id) >= 5) return;
    this.id.update((cur) => cur + 1);
  }

  protected prev() {
    if (untracked(this.id) <= 1) return;
    this.id.update((cur) => cur - 1);
  }
}
