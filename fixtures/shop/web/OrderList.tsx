import { findUser } from "@/users/repo";

export function OrderList({ userId }: { userId: number }) {
  void findUser(userId);
  return <ul className="orders" />;
}
