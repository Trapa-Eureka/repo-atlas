import { query } from "../db/client.js";
import { findUser } from "../users/repo.js";

export class OrderService {
  async place(userId: number) {
    const user = await findUser(userId);
    await query("INSERT INTO orders (user_id) VALUES ($1)", [user.id]);
    this.notify(user.email);
  }

  notify(email: string) {
    return `${process.env.SMTP_HOST}:${email}`;
  }
}

export default function recentOrders(year: number) {
  return query(
    `SELECT o.id, EXTRACT(YEAR FROM o.created_at) AS year
       FROM orders o
       JOIN users u ON u.id = o.user_id
      WHERE EXTRACT(YEAR FROM o.created_at) = $1`,
    [year],
  );
}
