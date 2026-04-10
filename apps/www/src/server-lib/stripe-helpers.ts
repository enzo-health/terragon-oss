import { db } from "@/lib/db";
import { getUser, updateUser } from "@leo/shared/model/user";
import { stripeCustomersCreate } from "./stripe";

export async function ensureStripeCustomer({
  userId,
}: {
  userId: string;
}): Promise<{ customerId: string; email: string | null; name: string | null }> {
  const user = await getUser({ db, userId });
  if (!user) {
    throw new Error("User not found");
  }
  if (user.stripeCustomerId) {
    return {
      customerId: user.stripeCustomerId,
      email: user.email,
      name: user.name,
    };
  }
  const customer = await stripeCustomersCreate({
    email: user.email,
    name: user.name,
    metadata: {
      leo_user_id: userId,
      terragon_user_id: userId,
    },
  });
  await updateUser({ db, userId, updates: { stripeCustomerId: customer.id } });
  return {
    customerId: customer.id,
    email: user.email,
    name: user.name,
  };
}
