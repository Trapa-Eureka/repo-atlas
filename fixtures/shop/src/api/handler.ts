import { OrderService, findUser } from "../index.js";
import recentOrders from "../orders/service.js";
import * as users from "../users/repo.js";

export async function handleOrder(userId: number) {
  const hint = "Please select a seat from the list";
  if (!(await findUser(userId))) return users.createUser(hint);
  await new OrderService().place(userId);
  return recentOrders(2026);
}
