import { query } from "../db/client.js";

export async function findUser(id: number) {
  const result = await query("SELECT id, email FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

export const createUser = async (email: string) => {
  await query(`INSERT INTO users (email) VALUES ($1)`, [email]);
};
