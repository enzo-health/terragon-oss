import { getReviews } from "@/server-actions/get-reviews";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const reviewQueryKeys = {
  list: () => ["reviews", "list"],
};

export function reviewsQueryOptions() {
  return getServerActionQueryOptions({
    queryKey: reviewQueryKeys.list(),
    queryFn: async () => {
      return await getReviews();
    },
  });
}
