import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { Reviews } from "@/components/review/main";
import { reviewsQueryOptions } from "@/queries/review-queries";

export const metadata: Metadata = {
  title: "Reviews | Terragon",
};

export default async function ReviewsPage() {
  await getUserIdOrRedirect();
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(reviewsQueryOptions());
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <Reviews />
      </div>
    </HydrationBoundary>
  );
}
