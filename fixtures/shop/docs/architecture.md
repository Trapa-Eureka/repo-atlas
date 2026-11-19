# Architecture

Orders are placed through `src/orders/service.ts`; see `OrderService.place` and `findUser()`.
User rows live in the `users` table, read through the [user repository](../src/users/repo.ts).
Set `DATABASE_URL` before starting. More at [the docs site](https://example.com/docs).

```ts
// `handleOrder` inside a fence is not a reference.
```
